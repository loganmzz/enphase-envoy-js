const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs/promises');
const axios = require('axios');

export function enphaseEnvoy(): string {
  return 'enphase-envoy';
}

interface TokenStorage {
    save(token: string): Promise<any>;
    load(): Promise<string>;
}

export class FileTokenStorage implements TokenStorage {

    constructor(public path: string) {
    }

    save(token: string): Promise<any> {
        return fs.writeFile(this.path, token, { encoding: 'utf-8' });
    }

    async load(): Promise<string> {
        try {
            await fs.access(this.path);
        } catch (err) {
            return undefined;
        }
        return await fs.readFile(this.path, { encoding: 'utf-8' });
    }
}


interface MainOpts {
    token_storage?: TokenStorage,
    auth_url?: string;
    serial_num?: string;
    login_email?: string;
    login_password?: string;
    config_file?: string;
}
export class Main {

    authHttp: any;
    envoyHttp: any;

    constructor(public opts: MainOpts) {
        axios.defaults.validateStatus = () => true;
        this.authHttp = axios.create({
            baseURL: this.opts.auth_url,
        });
        this.envoyHttp = axios.create({
            baseURL: 'https://envoy.local',
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            }),
        });

        for (const http of [this.authHttp, this.envoyHttp]) {
            http.interceptors.request.use(request => {
                console.log('Request.method=', request.url);
                console.log('Request.url=', request.url);
                console.log('Request.params=', request.params);
                console.log('Request.headers=', request.headers);
                return request;
            });
            http.interceptors.response.use(response => {
                console.log('Response.status=', response.status);
                console.log('Response.headers=', response.headers);
                console.log('Response.data=', response.data);
                return response;
            });
        }
    }

    static async new(opts: MainOpts): Promise<Main> {
        if (opts.config_file) {
            const json = (await fs.readFile(opts.config_file)).toString();
            const overrides = JSON.parse(json);
            opts = {
                ...opts,
                ...overrides,
            };
        }
        return new Main(opts);
    }

    generate_code_verifier(): string {
        return crypto
            .randomBytes(32)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }
    generate_code_challenge(code_verifier: string): string {
        const sha = crypto.createHash('sha256').update(code_verifier).digest();
        return Buffer.from(sha).toString('base64url');
    }

    async get_code(code_challenge: string): Promise<string> {
        console.log('\n\n-- Request code');
        const response = await this.authHttp.request({
            method: 'post',
            url: '/login',
            data: {
                username: this.opts.login_email,
                password: this.opts.login_password,
                codeChallenge: code_challenge,
                redirectUri: `${this.envoyHttp.baseURL}/auth/callback`,
                client: 'envoy-ui',
                clientId: 'envoy-ui-client',
                authFlow: 'oauth',
                serialNum: this.opts.serial_num,
                grantType: 'authorize',
                state: '',
                invalidSerialNum: '',
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            maxRedirects: 0,
        });
        if (response.status != 302) {
            const message = `Unexpected HTTP status. Expected: 302, Found: ${response.status}`;
            console.error(message);
            throw new Error(message);
        }
        const loginRedirectLocation = new URL(response.headers['location']);
        const loginRedirectParams = loginRedirectLocation.searchParams;
        return loginRedirectParams.get('code');
    }

    async get_jwt({code_verifier, code}: {code_verifier: string, code: string}): Promise<string> {
        console.log('\n\n-- Request JWT');
        const response = await this.envoyHttp.request({
            method: 'post',
            url: '/auth/get_jwt',
            data: {
                client_id: 'envoy-ui-1',
                code,
                code_verifier,
                grant_type: 'authorization_code',
                redirect_uri: `${this.envoyHttp.baseURL}/auth/callback`,
            },
            maxRedirects: 0,
        });
        return response.data.access_token;
    }

    async get_current_power(): Promise<{production: number, consumption: number, net: number}> {
        console.log('\n\n-- Get current power');
        const response = await this.envoyHttp.request({
            method: 'get',
            url: '/production.json?details=1',
        });
        if (response.status != 200) {
            const message = `Error while fetching production data (HTTP status: ${response.status})\n${JSON.stringify(response.data, null, 2)}`;
            console.error(message);
            throw new Error(message);
        }
        const production = response.data.production.reduce((sum, item) => sum + (item.type === 'eim' ? item.wNow : 0), 0);
        const consumption = response.data.consumption.reduce((sum, item) => sum + (item.type === 'eim' && item.measurementType === 'total-consumption' ? item.wNow : 0), 0);
        const net = response.data.consumption.reduce((sum, item) => sum + (item.type === 'eim' && item.measurementType === 'net-consumption' ? item.wNow: 0), 0);
        return {production, consumption, net};
    }

    async authenticate(): Promise<any> {
        let jwt = await this.opts.token_storage.load();
        if (jwt == undefined) {
            let code_verifier = this.generate_code_verifier();
            let code_challenge = this.generate_code_challenge(code_verifier);
            const code = await this.get_code(code_challenge);
            jwt = await this.get_jwt({code_verifier, code});
            await this.opts.token_storage.save(jwt);
        }
        this.envoyHttp.defaults.headers.common['Authorization'] = `Bearer ${jwt}`;
    }


    async main() {
        await this.authenticate();
        const power = await this.get_current_power();
        console.log(`Current power:\n${JSON.stringify(power, undefined, 2)}`);
        console.log('\n-- End');

    }
    //https://entrez.enphaseenergy.com/authorize?code_challenge=<...>&client_id=envoy-ui-client&redirect_uri=https://envoy.local/auth/callback&scope=<...>&response_type=code&code_challenge_method=S256
}
