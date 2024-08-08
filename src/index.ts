import puppeteer from '@cloudflare/puppeteer';

export default {
	async fetch(request: Request, env: Env) {

		let id = env.BROWSER.idFromName("browser");
		let obj = env.BROWSER.get(id);

		let resp = await obj.fetch(request);

		return resp;
	}
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
		const urlHeader = request.headers.get("url");
		const url = new URL(urlHeader ?? 'https://example.com')
		const userId = request.headers.get("user-id");

		if (!userId) {
			return new Response("User ID not found", { status: 400 });
		}

		// screen resolutions to test out
		const width = [1920]
		const height = [1080]

		const userFolder = `user-${btoa(userId)}`;
		const folder = `captures/${userFolder}`;

		//if there's a browser session open, re-use it
		if (!this.browser || !this.browser.isConnected()) {
			console.log(`Browser DO: Starting new instance`);
			try {
				this.browser = await puppeteer.launch(this.env.MYBROWSER);
			} catch (e) {
				console.log(`Browser DO: Could not start browser instance. Error: ${e}`);
				return new Response("Failed to start browser", { status: 500 });
			}
		}

		// Ensure browser is not null before proceeding
		if (!this.browser) {
			console.log(`Browser DO: Browser is null after attempted launch`);
			return new Response("Browser initialization failed", { status: 500 });
		}

		// Reset keptAlive after each call to the DO
		this.keptAliveInSeconds = 0;

		const captureKey = []

		try {
			const page = await this.browser.newPage();

			// take screenshots of each screen size
			for (let i = 0; i < width.length; i++) {
				await page.setViewport({ width: width[i], height: height[i] });
				await page.goto(url.href);
				const fileName = `${url.href}_${width[i]}x${height[i]}`;
				const key = `${folder}/${fileName}.jpg`;
				const sc = await page.screenshot({ path: `${fileName}.jpg`, fullPage: false });
				await this.env.BUCKET.put(key, sc);
				captureKey.push(key);
			}

			// Close tab when there is no more work to be done on the page
			await page.close();
		} catch (error) {
			console.error(`Error during page operations: ${error}`);
			return new Response("Error during page operations", { status: 500 });
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

		return new Response(JSON.stringify({ sucess: true, captureKey }), { status: 200 });
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