import { Actor, log } from 'apify';
import { PNG } from 'pngjs';

import imagemin from 'imagemin';
import imageminGiflossy from 'imagemin-giflossy';
import imageminGifsicle from 'imagemin-gifsicle';

const wait = async (time) => new Promise((resolve) => setTimeout(resolve, time));
const FAST_MODE_MIN_SCROLL_PERCENTAGE = 25;
const FAST_MODE_MAX_FRAME_RATE = 4;
const FAST_MODE_MAX_RECORDING_MS = 250;

const takeScreenshot = async (page) => {
    log.info('Taking screenshot');

    const screenshotBuffer = await page.screenshot({
        type: 'png',
    });

    return screenshotBuffer;
};

const parsePngBuffer = (buffer) => {
    const png = new PNG();
    return new Promise((resolve, reject) => {
        png.parse(buffer, (error, data) => {
            if (data) {
                resolve(data);
            } else {
                reject(error);
            }
        });
    });
};

const gifAddFrame = async (screenshotBuffer, gif) => {
    const png = await parsePngBuffer(screenshotBuffer);
    const pixels = png.data;

    log.debug('Adding frame to gif');
    gif.addFrame(pixels);
};

export const record = async (page, gif, recordingTime, frameRate) => {
    const captureDuration = Number(recordingTime) || 0;
    const fps = Math.max(1, Number(frameRate) || 1);

    if (captureDuration <= 0) return;

    const frameInterval = Math.round(1000 / fps);
    const frames = Math.max(1, Math.ceil(captureDuration / frameInterval));

    for (let itt = 0; itt < frames; itt++) {
        const frameStartedAt = Date.now();
        const screenshotBuffer = await takeScreenshot(page);
        await gifAddFrame(screenshotBuffer, gif);

        const elapsed = Date.now() - frameStartedAt;
        const remainingDelay = frameInterval - elapsed;

        if (remainingDelay > 0 && itt < frames - 1) {
            await wait(remainingDelay);
        }
    }
};

export const resolveCaptureConfig = ({
    fastMode = false,
    frameRate = 7,
    scrollPercentage = 10,
    recordingTimeBeforeAction = 1000,
    recordingTimeAfterClick = 0,
    lossyCompression = true,
    loslessCompression = false,
}) => {
    if (!fastMode) {
        return {
            fastMode: false,
            frameRate,
            scrollPercentage,
            recordingTimeBeforeAction,
            recordingTimeAfterClick,
            lossyCompression,
            loslessCompression,
        };
    }

    return {
        fastMode: true,
        frameRate: Math.max(1, Math.min(frameRate, FAST_MODE_MAX_FRAME_RATE)),
        scrollPercentage: Math.max(scrollPercentage, FAST_MODE_MIN_SCROLL_PERCENTAGE),
        recordingTimeBeforeAction: Math.min(recordingTimeBeforeAction, FAST_MODE_MAX_RECORDING_MS),
        recordingTimeAfterClick: Math.min(recordingTimeAfterClick, FAST_MODE_MAX_RECORDING_MS),
        lossyCompression: false,
        loslessCompression: false,
    };
};

export const getScrollParameters = async ({ page, viewportHeight, scrollPercentage }) => {
    const { pageHeight, scrollTop } = await page.evaluate(() => {
        // This actor intentionally captures page-level scrolling only.
        // Nested scroll containers are out of scope because viewport screenshots
        // cannot safely represent arbitrary inner scrollers without dedicated cropping.
        const scrollRoot = document.scrollingElement || document.documentElement || document.body;
        const fallbackRoot = scrollRoot === document.body ? document.documentElement : document.body;
        const effectiveScrollTop = window.pageYOffset
            || scrollRoot.scrollTop
            || fallbackRoot.scrollTop
            || 0;
        const effectiveScrollHeight = Math.max(
            scrollRoot.scrollHeight || 0,
            fallbackRoot.scrollHeight || 0,
            document.documentElement.scrollHeight || 0,
            document.body.scrollHeight || 0,
            window.innerHeight || 0,
        );

        return {
            pageHeight: effectiveScrollHeight,
            scrollTop: effectiveScrollTop,
        };
    });

    const effectiveViewportHeight = Math.max(1, viewportHeight);
    const initialPosition = effectiveViewportHeight + scrollTop;
    const scrollByAmount = Math.max(1, Math.round(effectiveViewportHeight * scrollPercentage / 100));

    return {
        pageHeight,
        initialPosition,
        scrollByAmount,
    };
};

export const scrollDownProcess = async ({ page, gif, viewportHeight, scrollPercentage }) => {
    let {
        pageHeight,
        initialPosition,
        scrollByAmount,
    } = await getScrollParameters({ page, viewportHeight, scrollPercentage });
    let scrolledUntil = initialPosition;

    while (pageHeight > scrolledUntil) {
        const screenshotBuffer = await takeScreenshot(page);

        await gifAddFrame(screenshotBuffer, gif);

        log.info(`Scrolling down by ${scrollByAmount} pixels`);
        await page.evaluate((scrollByAmount) => {
            window.scrollBy(0, scrollByAmount);
        }, scrollByAmount);

        const updatedScrollState = await getScrollParameters({ page, viewportHeight, scrollPercentage });
        const currentViewportBottom = updatedScrollState.initialPosition;

        if (currentViewportBottom <= scrolledUntil) {
            log.warning('Page did not scroll any further, stopping scroll capture early.');
            break;
        }

        pageHeight = updatedScrollState.pageHeight;
        scrollByAmount = updatedScrollState.scrollByAmount;
        scrolledUntil = currentViewportBottom;
    }

    const finalScreenshotBuffer = await takeScreenshot(page);
    await gifAddFrame(finalScreenshotBuffer, gif);
};

export const getGifBuffer = (gif, chunks) => {
    return new Promise((resolve, reject) => {
        gif.once('end', () => resolve(Buffer.concat(chunks)));
        gif.once('error', (error) => reject(error));
    });
};

export const createDatasetResult = ({
    gifUrlOriginal,
    gifUrlLossy,
    gifUrlLosless,
}) => {
    const result = {
        gifUrlOriginal,
    };

    if (gifUrlLossy) result.gifUrlLossy = gifUrlLossy;
    if (gifUrlLosless) result.gifUrlLosless = gifUrlLosless;

    return result;
};

const selectPlugin = (compressionType) => {
    switch (compressionType) {
        case 'lossy':
            return [
                imageminGiflossy({
                    lossy: 80,
                    optimizationLevel: 3,
                }),
            ];
        case 'losless':
            return [
                imageminGifsicle({
                    optimizationLevel: 3,
                }),
            ];
        default:
            throw new Error('Unknown compression type');
    }
};

export const compressGif = async (gifBuffer, compressionType) => {
    log.info('Compressing gif');
    const compressedBuffer = await imagemin.buffer(gifBuffer, {
        plugins: selectPlugin(compressionType),
    });
    return compressedBuffer;
};

export const saveGif = async (fileName, buffer) => {
    log.info(`Saving ${fileName} to key-value store`);
    const keyValueStore = await Actor.openKeyValueStore();
    const gifSaved = await keyValueStore.setValue(fileName, buffer, {
        contentType: 'image/gif',
    });
    return gifSaved;
};

export const slowDownAnimationsFn = async (page) => {
    log.info('Slowing down animations');

    const session = await page.target().createCDPSession();

    return await Promise.all([
        session.send('Animation.enable'),
        session.send('Animation.setPlaybackRate', {
            playbackRate: 0.1,
        }),
    ]);
};
