import { Actor, log } from 'apify';
import { PNG } from 'pngjs';

import imagemin from 'imagemin';
import imageminGiflossy from 'imagemin-giflossy';
import imageminGifsicle from 'imagemin-gifsicle';

const wait = async (time) => new Promise((resolve) => setTimeout(resolve, time));

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

export const getScrollParameters = async ({ page, viewportHeight, scrollPercentage }) => {
    const { pageHeight, scrollTop, clientHeight } = await page.evaluate(() => {
        const docRoot = document.scrollingElement || document.documentElement || document.body;
        const isElementScrollable = (element) => {
            if (!element || !(element instanceof Element)) return false;

            const style = window.getComputedStyle(element);
            const canScroll = /(auto|scroll|overlay)/.test(style.overflowY || '')
                || /(auto|scroll|overlay)/.test(style.overflow || '');

            return canScroll && (element.scrollHeight - element.clientHeight > 1);
        };

        let scrollRoot = window.__GIF_SCROLL_ROOT_ELEMENT;
        if (!scrollRoot || !(scrollRoot instanceof Element) || !document.contains(scrollRoot)) {
            const candidates = [
                docRoot,
                document.documentElement,
                document.body,
                ...document.querySelectorAll('*'),
            ].filter(Boolean);

            scrollRoot = candidates
                .filter(isElementScrollable)
                .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0] || docRoot;

            window.__GIF_SCROLL_ROOT_ELEMENT = scrollRoot;
        }

        const usesDocumentScrollRoot = scrollRoot === docRoot
            || scrollRoot === document.documentElement
            || scrollRoot === document.body;
        const effectiveScrollTop = usesDocumentScrollRoot
            ? (window.pageYOffset || docRoot.scrollTop || document.documentElement.scrollTop || document.body.scrollTop || 0)
            : scrollRoot.scrollTop;
        const effectiveClientHeight = usesDocumentScrollRoot
            ? (window.innerHeight || document.documentElement.clientHeight || scrollRoot.clientHeight || 0)
            : scrollRoot.clientHeight;
        const effectiveScrollHeight = Math.max(scrollRoot.scrollHeight, effectiveClientHeight);

        return {
            pageHeight: effectiveScrollHeight,
            scrollTop: effectiveScrollTop,
            clientHeight: effectiveClientHeight,
        };
    });

    const effectiveViewportHeight = Math.max(1, Math.min(viewportHeight, clientHeight || viewportHeight));
    const initialPosition = effectiveViewportHeight + scrollTop;
    const scrollByAmount = Math.max(1, Math.round(effectiveViewportHeight * scrollPercentage / 100));

    return {
        pageHeight,
        initialPosition,
        scrollByAmount,
        viewportHeight: effectiveViewportHeight,
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
            const docRoot = document.scrollingElement || document.documentElement || document.body;
            const scrollRoot = window.__GIF_SCROLL_ROOT_ELEMENT;

            if (scrollRoot && scrollRoot instanceof Element && scrollRoot !== docRoot && document.contains(scrollRoot)) {
                scrollRoot.scrollBy(0, scrollByAmount);
                return;
            }

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
