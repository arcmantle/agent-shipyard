import { fileURLToPath } from 'node:url';
import { handlePrototypeApi } from './prototype-api.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const site = new URL('../../logbook/packages/site/', import.meta.url);

export default ({ command }: { command: 'build' | 'serve' }) => {
	if (command === 'serve' && process.env.NODE_ENV === 'production')
		throw new Error('The harness prototype is disabled in production.');
	return {
		root,
		appType: 'mpa',
		publicDir: false,
		cacheDir: fileURLToPath(new URL('node_modules/.vite/harness', site)),
		resolve: {
			alias: {
				lit: fileURLToPath(new URL('node_modules/lit', site)),
				lucide: fileURLToPath(new URL('node_modules/lucide', site)),
			},
		},
		optimizeDeps: { entries: ['app.ts'] },
		server: {
			host: '127.0.0.1',
			port: Number(process.env.PORT || 5328),
			cors: false,
			fs: {
				allow: [
					root,
					fileURLToPath(new URL('../../logbook/node_modules/', import.meta.url)),
					fileURLToPath(new URL('node_modules/', site)),
				],
			},
		},
		plugins: [
			{
				name: 'harness-prototype',
				configureServer(server) {
					server.middlewares.use((request, response, next) => {
						void handlePrototypeApi(request, response, next).catch(next);
					});
				},
			},
		],
		test: { environment: 'happy-dom', include: ['**/*.test.ts'] },
	};
};
