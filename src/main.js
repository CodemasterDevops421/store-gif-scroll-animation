import { Actor, log } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import GifEncoder from 'gif-encoder';

import {
    capturePage,
    getGifBuffer,
    compressGif,
    saveAsset,
    saveGif,
    slowDownAnimationsFn,
    resolveCaptureConfig,
    createDatasetResult,
    encodeVideoFromFrames,
    getOutputFormatMetadata,
    buildOutputFileName,
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
        outputFormat = 'gif',
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
        outputFormat,
    });

    let outputUrl;
    let errorMessage;

    const describeCaptureStopReason = (captureCompleted, captureStopReason) => {
        if (captureCompleted) return 'capture reached the bottom of the page';

        switch (captureStopReason) {
            case 'page_stopped_moving':
                return 'capture stopped because the page stopped moving';
            case 'max_steps_reached':
                return 'capture stopped because the internal step limit was reached';
            case 'max_duration_reached':
                return 'capture stopped because the internal duration limit was reached';
            case 'scroll_not_requested':
                return 'capture finished without scrolling';
            default:
                return `capture stopped because of ${captureStopReason}`;
        }
    };

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

            log.info(`Output format: ${captureConfig.outputFormat}`);

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

            const outputMetadata = getOutputFormatMetadata(captureConfig.outputFormat);
            const frameBuffers = captureConfig.outputFormat === 'gif' ? undefined : [];
            const chunks = [];
            let gif;

            if (captureConfig.outputFormat === 'gif') {
                gif = new GifEncoder(viewportWidth, viewportHeight);
                gif.setFrameRate(captureConfig.frameRate);
                gif.setRepeat(0); // loop indefinitely
                gif.on('data', (chunk) => chunks.push(chunk));
                gif.writeHeader();
            }

            if (clickSelector) {
                await Actor.setStatusMessage(`Page loaded, performing pre-capture interaction before ${captureConfig.outputFormat.toUpperCase()} capture`);
            } else {
                await Actor.setStatusMessage(`Page loaded, recording ${modeLabel} ${captureConfig.outputFormat.toUpperCase()} capture`);
            }

            const captureResult = await capturePage({
                page,
                gif,
                viewportHeight,
                captureConfig,
                scrollDown,
                clickSelector,
                frameBuffers,
            });
            const captureSummary = describeCaptureStopReason(
                captureResult.captureCompleted,
                captureResult.captureStopReason,
            );
            log.info(`Capture summary: ${captureSummary}. Steps taken: ${captureResult.scrollStepsTaken}.`);
            await Actor.setStatusMessage(`Capture finished: ${captureSummary}`);

            const urlObj = new URL(validUrl);
            const siteName = urlObj.hostname;
            const baseFileName = `${siteName}-scroll`;

            // Save to dataset so there is higher chance the user will find it

            const kvStore = await Actor.openKeyValueStore();
            const filenameOrig = buildOutputFileName({
                baseFileName,
                variant: 'original',
                extension: outputMetadata.extension,
            });
            let gifUrlOriginal;
            let gifUrlLossy;
            let gifUrlLosless;
            let videoUrlOriginal;

            if (captureConfig.outputFormat === 'gif') {
                const gifBufferPromise = getGifBuffer(gif, chunks);
                gif.finish();
                const gifBuffer = await gifBufferPromise;

                await saveGif(filenameOrig, gifBuffer);
                gifUrlOriginal = kvStore.getPublicUrl(filenameOrig);
                outputUrl = gifUrlOriginal;

                if (captureConfig.lossyCompression) {
                    const lossyBuffer = await compressGif(gifBuffer, 'lossy');
                    log.info('Lossy compression finished');
                    const filenameLossy = buildOutputFileName({
                        baseFileName,
                        variant: 'lossy-comp',
                        extension: 'gif',
                    });
                    await saveGif(filenameLossy, lossyBuffer);
                    gifUrlLossy = kvStore.getPublicUrl(filenameLossy);
                }

                if (captureConfig.loslessCompression) {
                    const loslessBuffer = await compressGif(gifBuffer, 'losless');
                    log.info('Losless compression finished');
                    const filenameLosless = buildOutputFileName({
                        baseFileName,
                        variant: 'losless-comp',
                        extension: 'gif',
                    });
                    await saveGif(filenameLosless, loslessBuffer);
                    gifUrlLosless = kvStore.getPublicUrl(filenameLosless);
                }
            } else {
                const videoBuffer = await encodeVideoFromFrames({
                    frameBuffers,
                    frameRate: captureConfig.frameRate,
                    outputFormat: captureConfig.outputFormat,
                });
                await saveAsset(filenameOrig, videoBuffer, outputMetadata.contentType);
                videoUrlOriginal = kvStore.getPublicUrl(filenameOrig);
                outputUrl = videoUrlOriginal;
                log.info(`Compression skipped for ${captureConfig.outputFormat.toUpperCase()} output.`);
            }

            await Actor.pushData(createDatasetResult({
                outputFormat: captureConfig.outputFormat,
                outputUrlOriginal: outputUrl,
                outputMimeType: outputMetadata.contentType,
                gifUrlOriginal,
                gifUrlLossy,
                gifUrlLosless,
                videoUrlOriginal,
                captureCompleted: captureResult.captureCompleted,
                captureStopReason: captureResult.captureStopReason,
                scrollStepsTaken: captureResult.scrollStepsTaken,
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

    if (outputUrl) {
        await Actor.exit(`${captureConfig.outputFormat.toUpperCase()} created successfully. Output URL: ${outputUrl}. Open dataset results for more details.`);
    } else {
        await Actor.fail(`Could not create ${captureConfig.outputFormat.toUpperCase()} because of error: ${errorMessage}`);
    }
});
