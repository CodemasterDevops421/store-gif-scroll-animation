import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Actor, log } from 'apify';
import ffmpegStatic from 'ffmpeg-static';
import { PNG } from 'pngjs';

import imagemin from 'imagemin';
import imageminGiflossy from 'imagemin-giflossy';
import imageminGifsicle from 'imagemin-gifsicle';

const wait = async (time) => new Promise((resolve) => setTimeout(resolve, time));
const FAST_MODE_MIN_SCROLL_PERCENTAGE = 25;
const FAST_MODE_MAX_FRAME_RATE = 4;
const FAST_MODE_MAX_RECORDING_MS = 250;
const DEFAULT_MAX_SCROLL_STEPS = 400;
const DEFAULT_MAX_SCROLL_DURATION_MS = 120000;

const OUTPUT_FORMATS = {
    gif: {
        extension: 'gif',
        contentType: 'image/gif',
    },
    webm: {
        extension: 'webm',
        contentType: 'video/webm',
    },
    mp4: {
        extension: 'mp4',
        contentType: 'video/mp4',
    },
};

const normalizeOutputFormat = (outputFormat = 'gif') => {
    const normalizedOutputFormat = String(outputFormat).toLowerCase();

    if (!OUTPUT_FORMATS[normalizedOutputFormat]) {
        throw new Error(`Unsupported output format: ${outputFormat}. Expected one of ${Object.keys(OUTPUT_FORMATS).join(', ')}.`);
    }

    return normalizedOutputFormat;
};

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

const captureFrame = async ({ page, gif, frameBuffers }) => {
    const screenshotBuffer = await takeScreenshot(page);

    if (frameBuffers) {
        frameBuffers.push(screenshotBuffer);
    }

    if (gif) {
        await gifAddFrame(screenshotBuffer, gif);
    }

    return screenshotBuffer;
};

const getVideoArgs = ({ frameRate, inputPattern, outputFormat, outputPath }) => {
    const commonArgs = [
        '-y',
        '-framerate',
        String(Math.max(1, frameRate)),
        '-start_number',
        '1',
        '-i',
        inputPattern,
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    ];

    if (outputFormat === 'webm') {
        return [
            ...commonArgs,
            '-c:v',
            'libvpx-vp9',
            '-pix_fmt',
            'yuv420p',
            '-row-mt',
            '1',
            '-deadline',
            'good',
            '-cpu-used',
            '2',
            '-b:v',
            '0',
            '-crf',
            '32',
            outputPath,
        ];
    }

    return [
        ...commonArgs,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        outputPath,
    ];
};

export const getOutputFormatMetadata = (outputFormat = 'gif') => {
    return OUTPUT_FORMATS[normalizeOutputFormat(outputFormat)];
};

export const record = async (page, gif, recordingTime, frameRate, frameBuffers) => {
    const captureDuration = Number(recordingTime) || 0;
    const fps = Math.max(1, Number(frameRate) || 1);

    if (captureDuration <= 0) return;

    const frameInterval = Math.round(1000 / fps);
    const frames = Math.max(1, Math.ceil(captureDuration / frameInterval));

    for (let itt = 0; itt < frames; itt++) {
        const frameStartedAt = Date.now();
        await captureFrame({ page, gif, frameBuffers });

        const elapsed = Date.now() - frameStartedAt;
        const remainingDelay = frameInterval - elapsed;

        if (remainingDelay > 0 && itt < frames - 1) {
            await wait(remainingDelay);
        }
    }
};

export const capturePage = async ({
    page,
    gif,
    viewportHeight,
    captureConfig,
    scrollDown,
    clickSelector,
    frameBuffers,
    recordFn = record,
    scrollFn = scrollDownProcess,
    clickTimeoutMs = 5000,
}) => {
    if (clickSelector) {
        try {
            await page.waitForSelector(clickSelector, { timeout: clickTimeoutMs });
            log.info(`Clicking element with selector ${clickSelector} before capture starts`);
            await page.click(clickSelector);
        } catch (err) {
            log.warning('Could not click pre-capture element, click selector is likely incorrect. Continuing without click.');
        }

        await recordFn(page, gif, captureConfig.recordingTimeAfterClick, captureConfig.frameRate, frameBuffers);
    } else {
        await recordFn(page, gif, captureConfig.recordingTimeBeforeAction, captureConfig.frameRate, frameBuffers);
    }

    if (scrollDown) {
        return await scrollFn({
            page,
            gif,
            viewportHeight,
            scrollPercentage: captureConfig.scrollPercentage,
            frameBuffers,
        });
    }

    return {
        captureCompleted: true,
        captureStopReason: 'scroll_not_requested',
        scrollStepsTaken: 0,
    };
};

export const resolveCaptureConfig = ({
    fastMode = false,
    frameRate = 7,
    scrollPercentage = 10,
    recordingTimeBeforeAction = 1000,
    recordingTimeAfterClick = 0,
    lossyCompression = true,
    loslessCompression = false,
    outputFormat = 'gif',
}) => {
    const normalizedOutputFormat = normalizeOutputFormat(outputFormat);
    const compressionSupported = normalizedOutputFormat === 'gif';

    if (!fastMode) {
        return {
            fastMode: false,
            frameRate,
            scrollPercentage,
            recordingTimeBeforeAction,
            recordingTimeAfterClick,
            lossyCompression: compressionSupported ? lossyCompression : false,
            loslessCompression: compressionSupported ? loslessCompression : false,
            outputFormat: normalizedOutputFormat,
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
        outputFormat: normalizedOutputFormat,
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

export const scrollDownProcess = async ({
    page,
    gif,
    viewportHeight,
    scrollPercentage,
    frameBuffers,
    maxScrollSteps = DEFAULT_MAX_SCROLL_STEPS,
    maxScrollDurationMs = DEFAULT_MAX_SCROLL_DURATION_MS,
    nowFn = Date.now,
}) => {
    let {
        pageHeight,
        initialPosition,
        scrollByAmount,
    } = await getScrollParameters({ page, viewportHeight, scrollPercentage });
    let scrolledUntil = initialPosition;
    let stepsTaken = 0;
    const startedAt = nowFn();
    let captureStopReason = 'bottom_reached';

    while (pageHeight > scrolledUntil) {
        if (stepsTaken >= maxScrollSteps) {
            captureStopReason = 'max_steps_reached';
            log.warning(`Stopping scroll capture after ${stepsTaken} steps because the internal step limit was reached.`);
            break;
        }

        if ((nowFn() - startedAt) >= maxScrollDurationMs) {
            captureStopReason = 'max_duration_reached';
            log.warning(`Stopping scroll capture after ${nowFn() - startedAt} ms because the internal duration limit was reached.`);
            break;
        }

        await captureFrame({ page, gif, frameBuffers });

        log.info(`Scrolling down by ${scrollByAmount} pixels`);
        await page.evaluate((nextScrollByAmount) => {
            window.scrollBy(0, nextScrollByAmount);
        }, scrollByAmount);

        const updatedScrollState = await getScrollParameters({ page, viewportHeight, scrollPercentage });
        const currentViewportBottom = updatedScrollState.initialPosition;

        if (currentViewportBottom <= scrolledUntil) {
            captureStopReason = 'page_stopped_moving';
            log.warning('Page did not scroll any further, stopping scroll capture early.');
            break;
        }

        stepsTaken += 1;
        pageHeight = updatedScrollState.pageHeight;
        scrollByAmount = updatedScrollState.scrollByAmount;
        scrolledUntil = currentViewportBottom;
    }

    await captureFrame({ page, gif, frameBuffers });

    return {
        captureCompleted: captureStopReason === 'bottom_reached',
        captureStopReason,
        scrollStepsTaken: stepsTaken,
    };
};

export const getGifBuffer = (gif, chunks) => {
    return new Promise((resolve, reject) => {
        gif.once('end', () => resolve(Buffer.concat(chunks)));
        gif.once('error', (error) => reject(error));
    });
};

export const encodeVideoFromFrames = async ({
    frameBuffers,
    frameRate,
    outputFormat,
}) => {
    const normalizedOutputFormat = normalizeOutputFormat(outputFormat);

    if (normalizedOutputFormat === 'gif') {
        throw new Error('Video encoding only supports mp4 and webm output formats.');
    }

    if (!ffmpegStatic) {
        throw new Error('ffmpeg-static is not available, video output cannot be generated.');
    }

    if (!Array.isArray(frameBuffers) || frameBuffers.length === 0) {
        throw new Error('No captured frames are available for video encoding.');
    }

    const outputMetadata = getOutputFormatMetadata(normalizedOutputFormat);
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'page-capture-'));
    const inputPattern = path.join(tempDirectory, 'frame-%06d.png');
    const outputPath = path.join(tempDirectory, `capture.${outputMetadata.extension}`);

    try {
        await Promise.all(frameBuffers.map((buffer, index) => {
            const frameFileName = `frame-${String(index + 1).padStart(6, '0')}.png`;
            return writeFile(path.join(tempDirectory, frameFileName), buffer);
        }));

        const args = getVideoArgs({
            frameRate,
            inputPattern,
            outputFormat: normalizedOutputFormat,
            outputPath,
        });

        log.info(`Encoding ${normalizedOutputFormat.toUpperCase()} output with ffmpeg`);

        await new Promise((resolve, reject) => {
            const ffmpegProcess = spawn(ffmpegStatic, args, {
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';

            ffmpegProcess.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            ffmpegProcess.on('error', reject);
            ffmpegProcess.on('close', (code) => {
                if (code === 0) {
                    resolve();
                    return;
                }

                reject(new Error(`ffmpeg exited with code ${code}. ${stderr.trim()}`.trim()));
            });
        });

        return await readFile(outputPath);
    } finally {
        await rm(tempDirectory, { recursive: true, force: true });
    }
};

export const createDatasetResult = ({
    outputFormat = 'gif',
    outputUrlOriginal,
    outputMimeType,
    gifUrlOriginal,
    gifUrlLossy,
    gifUrlLosless,
    videoUrlOriginal,
    captureCompleted,
    captureStopReason,
    scrollStepsTaken,
}) => {
    const normalizedOutputFormat = normalizeOutputFormat(outputFormat);
    const result = {
        outputFormat: normalizedOutputFormat,
        outputUrlOriginal,
        outputMimeType,
        captureCompleted,
        captureStopReason,
        scrollStepsTaken,
    };

    if (normalizedOutputFormat === 'gif') {
        result.gifUrlOriginal = gifUrlOriginal || outputUrlOriginal;
        if (gifUrlLossy) result.gifUrlLossy = gifUrlLossy;
        if (gifUrlLosless) result.gifUrlLosless = gifUrlLosless;
    } else if (videoUrlOriginal || outputUrlOriginal) {
        result.videoUrlOriginal = videoUrlOriginal || outputUrlOriginal;
    }

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

export const saveAsset = async (fileName, buffer, contentType) => {
    log.info(`Saving ${fileName} to key-value store`);
    const keyValueStore = await Actor.openKeyValueStore();
    const assetSaved = await keyValueStore.setValue(fileName, buffer, {
        contentType,
    });
    return assetSaved;
};

export const saveGif = async (fileName, buffer) => {
    return await saveAsset(fileName, buffer, 'image/gif');
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
