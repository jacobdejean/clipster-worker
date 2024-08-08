import puppeteer from '@cloudflare/puppeteer';
import { createClerkClient } from '@clerk/backend';
import { generateId } from './utils';

/*
 On get, this entry point is will return a URL to a publicly available r2 object.
 This response url is in the form of
 - 'https://r2.clipster.dev/captures/user-{userId}/{fileName}.jpg'.
 - userId is clerk user's id but base64 encoded
 - filename is '{captureKey}.jpg'

 On post, this entry point will capture the url provided and store it in the bucket.
 - Expects form post with 'url' field

 This entry point is protected with Clerk, expects a request sent from a signed-in
 user of clipster.dev.

 Will keep the browser alive for 60 seconds after the last request
*/

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
		const requestState = await clerk.authenticateRequest(request);
		const authState = requestState.toAuth();

		if (!authState || !authState?.userId) {
			return Response.redirect(requestState.signInUrl, 307);
		}

		switch (request.method) {
			case 'GET': {
				const origin = env.BUCKET_ORIGIN;
				const captureUrl = url.searchParams.get('url');
				return new Response(`Hello from the browser Durable Object! Bucket origin: ${origin}`);
			}
			case 'POST': {
				const formData = await request.formData();
				const url = formData.get('url');

				if (!url || !authState.userId) {
					return new Response('Invalid capture options', { status: 400 });
				}

				const id = env.BROWSER.idFromName('browser');
				const obj = env.BROWSER.get(id);

				const doRequest = new Request('clipster://capture', { headers: { 'user-id': authState.userId, url: url.toString() } });
				const resp = await obj.fetch(doRequest);

				return resp;
			}
			default: {
				return new Response('Invalid method', { status: 405 });
			}
		}
	},
};

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

export class Browser {
	private state: DurableObjectState;
	private env: Env;
	private keptAliveInSeconds: number;
	private storage: DurableObjectStorage;
	private browser: puppeteer.Browser | null;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.keptAliveInSeconds = 0;
		this.storage = this.state.storage;
	}

	async fetch(request: Request) {
		const urlHeader = request.headers.get('url');
		const userId = request.headers.get('user-id');
		const fullPage = request.headers.get('full-page');

		if (!urlHeader) {
			return Response.json({ success: false, error: 'Invalid capture options: Missing URL' }, { status: 400 });
		}

		const url = new URL(urlHeader);

		if (!userId) {
			return Response.json({ success: false, error: 'Invalid capture options: Missing user ID' }, { status: 400 });
		}

		const folder = `captures/user-${btoa(userId)}`;

		//if there's a browser session open, re-use it
		if (!this.browser || !this.browser.isConnected()) {
			console.log(`Browser DO: Starting new instance`);
			try {
				this.browser = await puppeteer.launch(this.env.MYBROWSER);
			} catch (e) {
				console.log(`Browser DO: Could not start browser instance. Error: ${e}`);
				return Response.json({ success: false, error: 'Failed to start browser' }, { status: 500 });
			}
		}

		// Ensure browser is not null before proceeding
		if (!this.browser) {
			console.log(`Browser DO: Browser is null after attempted launch`);
			return Response.json({ success: false, error: 'Browser initialization failed' }, { status: 500 });
		}

		// Reset keptAlive after each call to the DO
		this.keptAliveInSeconds = 0;

		const width = 1920;
		const height = 1080;

		const captureKey = generateId();

		try {
			const page = await this.browser.newPage();

			await page.setViewport({ width, height });
			await page.goto(url.href);

			const fileName = `${captureKey}.jpg`;
			const sc = await page.screenshot({ path: fileName, fullPage: Boolean(fullPage) });

			const bucketKey = `${folder}/${fileName}`;
			await this.env.BUCKET.put(bucketKey, sc);

			await page.close();
		} catch (error) {
			return Response.json({ success: false, error: 'Error during page operations' }, { status: 500 });
		}

		// Reset keptAlive after performing tasks to the DO.
		this.keptAliveInSeconds = 0;

		// set the first alarm to keep DO alive
		let currentAlarm = await this.storage.getAlarm();
		if (currentAlarm == null) {
			console.log(`Browser DO: setting alarm`);
			const TEN_SECONDS = 10 * 1000;
			await this.storage.setAlarm(Date.now() + TEN_SECONDS);
		}

		return Response.json({ success: true, key: captureKey }, { status: 200 });
	}

	async alarm() {
		this.keptAliveInSeconds += 10;

		// Extend browser DO life
		if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
			console.log(`Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
			// You could ensure the ws connection is kept alive by requesting something
			// or just let it close automatically when there  is no work to be done
			// for example, `await this.browser.version()`
		} else {
			console.log(`Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`);
			if (this.browser) {
				console.log(`Closing browser.`);
				await this.browser.close();
			}
		}
	}
}
