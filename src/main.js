import { Actor, log } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import GifEncoder from 'gif-encoder';

import {
    record,
    scrollDownProcess,
    getGifBuffer,
    compressGif,
    saveGif,
    slowDownAnimationsFn,
    resolveCaptureConfig,
    createDatasetResult,
} from './helper.js';

const wait = async (time) => {
    log.info(`Wait for ${time} ms`);
    return new Promise((resolve) => setTimeout(resolve, time));
};

Actor.main(async () => {
    const input = await Actor.getInput();

    if (!input || typeof input !== 'object') {
        throw new Error('Actor input is missing. Provide at least `url` and `proxyOptions`.');
    }

    const {
        url,
        viewportHeight = 768,
        viewportWidth = 1366,
        slowDownAnimations,
        waitToLoadPage = 0,
        cookieWindowSelector,
        frameRate = 7,
        recordingTimeBeforeAction = 1000,
        scrollDown = true,
        scrollPercentage = 10,
        clickSelector,
        recordingTimeAfterClick = 0,
        lossyCompression,
        loslessCompression,
        fastMode = false,
        proxyOptions,
    } = input;

    if (!url || typeof url !== 'string') {
        throw new Error('Input field `url` is required and must be a string.');
    }

    // Check in case the input URL does not include a protocol.
    const validUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;

    const proxyConfiguration = await Actor.createProxyConfiguration(proxyOptions);
    const captureConfig = resolveCaptureConfig({
        fastMode,
        frameRate,
        scrollPercentage,
        recordingTimeBeforeAction,
        recordingTimeAfterClick,
        lossyCompression,
        loslessCompression,
    });

    let gifUrl;
    let errorMessage;

    // We do just single request but wrap in crawler for error retries
    const crawler = new PuppeteerCrawler({
        proxyConfiguration,
        browserPoolOptions: {
            // We don't want to have randomly overridden browser appearance
            useFingerprints: false,
        },
        launchContext: {
            launchOptions: {
                defaultViewport: {
                    width: viewportWidth,
                    height: viewportHeight,
                },
            },
        },
        // Long pages can legitimately take several minutes to capture frame-by-frame.
        requestHandlerTimeoutSecs: 900,
        navigationTimeoutSecs: 90,
        preNavigationHooks: [
            async ({ page }, gotoOptions) => {
                if (slowDownAnimations) {
                    await slowDownAnimationsFn(page);
                }

                gotoOptions.waitUntil = 'networkidle2';
            },
        ],
        requestHandler: async ({ page }) => {
            const modeLabel = captureConfig.fastMode ? 'fast mode' : 'standard mode';
            await Actor.setStatusMessage(`Page loaded, starting gif recording in ${modeLabel}`);
            log.info(`Setting page viewport to ${viewportWidth}x${viewportHeight}`);
            log.info(`Capture mode: ${modeLabel}`);

            if (captureConfig.fastMode) {
                log.info(`Fast mode enabled, using ${captureConfig.frameRate} fps, ${captureConfig.scrollPercentage}% scroll steps, and skipping compression.`);
            }

            if (waitToLoadPage) {
                await wait(waitToLoadPage);
            }

            // remove cookie window if specified
            if (cookieWindowSelector) {
                try {
                    await page.waitForSelector(cookieWindowSelector, { timeout: 5000 });

                    log.info('Removing cookie pop-up window');
                    await page.$eval(cookieWindowSelector, (el) => el.remove());
                } catch (err) {
                    log.warning('Could not remove cookie banner. Selector for cookie pop-up window is likely incorrect. '
                        + `Continuing with it present.`);
                }
            }

            // set-up gif encoder
            const chunks = [];
            const gif = new GifEncoder(viewportWidth, viewportHeight);

            gif.setFrameRate(captureConfig.frameRate);
            gif.setRepeat(0); // loop indefinitely
            gif.on('data', (chunk) => chunks.push(chunk));
            gif.writeHeader();

            // add first frame multiple times so there is some delay before gif starts visually scrolling
            await record(page, gif, captureConfig.recordingTimeBeforeAction, captureConfig.frameRate);

            // start scrolling down and take screenshots
            if (scrollDown) {
                await scrollDownProcess({
                    page,
                    gif,
                    viewportHeight,
                    scrollPercentage: captureConfig.scrollPercentage,
                });
            }

            // click element and record the action
            if (clickSelector) {
                try {
                    await page.waitForSelector(clickSelector, { timeout: 5000 });
                    log.info(`Clicking element with selector ${clickSelector}`);
                    await page.click(clickSelector);
                } catch (err) {
                    log.warning('Could not click on click button, click selector is likely incorrect. Continuing without click.');
                }

                await record(page, gif, captureConfig.recordingTimeAfterClick, captureConfig.frameRate);
            }

            const gifBufferPromise = getGifBuffer(gif, chunks);
            gif.finish();
            const gifBuffer = await gifBufferPromise;

            const urlObj = new URL(validUrl);
            const siteName = urlObj.hostname;
            const baseFileName = `${siteName}-scroll`;

            // Save to dataset so there is higher chance the user will find it

            const kvStore = await Actor.openKeyValueStore();

            const filenameOrig = `${baseFileName}_original`;
            await saveGif(filenameOrig, gifBuffer);
            const gifUrlOriginal = kvStore.getPublicUrl(filenameOrig);
            let gifUrlLossy;
            let gifUrlLosless;
            gifUrl = gifUrlOriginal;

            if (captureConfig.lossyCompression) {
                const lossyBuffer = await compressGif(gifBuffer, 'lossy');
                log.info('Lossy compression finished');
                const filenameLossy = `${baseFileName}_lossy-comp`;
                await saveGif(filenameLossy, lossyBuffer);
                gifUrlLossy = kvStore.getPublicUrl(filenameLossy);
            }

            if (captureConfig.loslessCompression) {
                const loslessBuffer = await compressGif(gifBuffer, 'losless');
                log.info('Losless compression finished');
                const filenameLosless = `${baseFileName}_losless-comp`;
                await saveGif(filenameLosless, loslessBuffer);
                gifUrlLosless = kvStore.getPublicUrl(filenameLosless);
            }

            await Actor.pushData(createDatasetResult({
                gifUrlOriginal,
                gifUrlLossy,
                gifUrlLosless,
            }));
        },
        failedRequestHandler: async ({ request }) => {
            // Print last error message as status code if complete fail happens
            errorMessage = request.errorMessages[request.errorMessages.length - 1];
        },
    });

    await Actor.setStatusMessage(`Opening page: ${validUrl}`);
    const initRequest = { url: validUrl };

    await crawler.run([initRequest]);

    if (gifUrl) {
        await Actor.exit(`Gif created successfully. Gif URL: ${gifUrl}. Open dataset results for more details.`);
    } else {
        await Actor.fail(`Could not create GIF because of error: ${errorMessage}`);
    }
});
