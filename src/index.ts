import {
    FileTokenStorage,
    Main,
} from './lib/enphase-envoy';

(async () => {
    const main = await Main.new({
        token_storage: new FileTokenStorage('./token.dat'),
        auth_url: 'https://entrez.enphaseenergy.com',
        config_file: '.local.main.json',
    })
    main.main();
})();
