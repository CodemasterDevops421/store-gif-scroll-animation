import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { log } from 'apify';

import {
    capturePage,
    createDatasetResult,
    getGifBuffer,
    getOutputFormatMetadata,
    getScrollParameters,
    resolveCaptureConfig,
    scrollDownProcess,
} from '../src/helper.js';

const ONE_BY_ONE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
    'base64',
);

const createMockPage = ({
    viewportHeight = 100,
    scrollPercentage = 50,
    initialPageHeight = 300,
    initialScrollTop = 0,
    pageYOffsetSequence,
    scrollRootSequence,
    fallbackScrollTopSequence,
    pageHeightSequence,
    stopMovingAfterScroll = false,
}) => {
    let evaluateCall = 0;
    const state = {
        scrollTop: initialScrollTop,
        pageHeight: initialPageHeight,
    };

    const screenshots = [];
    const scrollCalls = [];

    const readSequenceValue = (sequence, fallback) => {
        if (!sequence || sequence.length === 0) return fallback;
        const index = Math.min(evaluateCall, sequence.length - 1);
        return sequence[index];
    };

    return {
        page: {
            screenshot: async () => {
                screenshots.push(state.scrollTop);
                return ONE_BY_ONE_PNG;
            },
            evaluate: async (_fn, arg) => {
                if (typeof arg === 'number') {
                    scrollCalls.push(arg);

                    if (!stopMovingAfterScroll) {
                        state.scrollTop += arg;
                    }

                    return undefined;
                }

                const currentScrollTop = readSequenceValue(scrollRootSequence, state.scrollTop);
                const currentFallbackScrollTop = readSequenceValue(fallbackScrollTopSequence, 0);
                const currentPageYOffset = readSequenceValue(pageYOffsetSequence, 0);
                const currentPageHeight = readSequenceValue(pageHeightSequence, state.pageHeight);

                evaluateCall += 1;
                state.scrollTop = currentPageYOffset || currentScrollTop || currentFallbackScrollTop || state.scrollTop;
                state.pageHeight = currentPageHeight;

                return {
                    pageHeight: currentPageHeight,
                    scrollTop: state.scrollTop,
                };
            },
        },
        getScrollCalls: () => [...scrollCalls],
        getScreenshotCount: () => screenshots.length,
        viewportHeight,
        scrollPercentage,
    };
};

test('getScrollParameters uses the configured viewport for page-level capture', async () => {
    const { page } = createMockPage({
        viewportHeight: 120,
        initialPageHeight: 480,
        initialScrollTop: 30,
    });

    const parameters = await getScrollParameters({
        page,
        viewportHeight: 120,
        scrollPercentage: 25,
    });

    assert.equal(parameters.pageHeight, 480);
    assert.equal(parameters.initialPosition, 150);
    assert.equal(parameters.scrollByAmount, 30);
    assert.ok(!('viewportHeight' in parameters));
});

test('resolveCaptureConfig leaves normal mode settings unchanged', () => {
    const config = resolveCaptureConfig({
        fastMode: false,
        frameRate: 7,
        scrollPercentage: 10,
        recordingTimeBeforeAction: 1000,
        recordingTimeAfterClick: 500,
        lossyCompression: true,
        loslessCompression: true,
        outputFormat: 'gif',
    });

    assert.deepEqual(config, {
        fastMode: false,
        frameRate: 7,
        scrollPercentage: 10,
        recordingTimeBeforeAction: 1000,
        recordingTimeAfterClick: 500,
        lossyCompression: true,
        loslessCompression: true,
        outputFormat: 'gif',
    });
});

test('resolveCaptureConfig applies the deterministic fast-mode preset', () => {
    const config = resolveCaptureConfig({
        fastMode: true,
        frameRate: 9,
        scrollPercentage: 10,
        recordingTimeBeforeAction: 1000,
        recordingTimeAfterClick: 600,
        lossyCompression: true,
        loslessCompression: true,
        outputFormat: 'gif',
    });

    assert.deepEqual(config, {
        fastMode: true,
        frameRate: 4,
        scrollPercentage: 25,
        recordingTimeBeforeAction: 250,
        recordingTimeAfterClick: 250,
        lossyCompression: false,
        loslessCompression: false,
        outputFormat: 'gif',
    });
});

test('resolveCaptureConfig disables GIF compression for video output', () => {
    const config = resolveCaptureConfig({
        fastMode: false,
        frameRate: 7,
        scrollPercentage: 10,
        recordingTimeBeforeAction: 1000,
        recordingTimeAfterClick: 500,
        lossyCompression: true,
        loslessCompression: true,
        outputFormat: 'webm',
    });

    assert.deepEqual(config, {
        fastMode: false,
        frameRate: 7,
        scrollPercentage: 10,
        recordingTimeBeforeAction: 1000,
        recordingTimeAfterClick: 500,
        lossyCompression: false,
        loslessCompression: false,
        outputFormat: 'webm',
    });
});

test('getOutputFormatMetadata returns MIME details for video output', () => {
    assert.deepEqual(getOutputFormatMetadata('mp4'), {
        extension: 'mp4',
        contentType: 'video/mp4',
    });
});

test('capturePage clicks before the first record call', async () => {
    const events = [];
    const page = {
        waitForSelector: async () => events.push('waitForSelector'),
        click: async () => events.push('click'),
    };

    await capturePage({
        page,
        gif: {},
        viewportHeight: 100,
        scrollDown: false,
        clickSelector: '#age-yes',
        captureConfig: {
            frameRate: 7,
            scrollPercentage: 10,
            recordingTimeBeforeAction: 1000,
            recordingTimeAfterClick: 500,
        },
        recordFn: async () => events.push('record'),
    });

    assert.deepEqual(events, ['waitForSelector', 'click', 'record']);
});

test('capturePage starts scroll only after the pre-capture click path finishes', async () => {
    const events = [];
    const page = {
        waitForSelector: async () => events.push('waitForSelector'),
        click: async () => events.push('click'),
    };

    await capturePage({
        page,
        gif: {},
        viewportHeight: 100,
        scrollDown: true,
        clickSelector: '#age-yes',
        captureConfig: {
            frameRate: 7,
            scrollPercentage: 10,
            recordingTimeBeforeAction: 1000,
            recordingTimeAfterClick: 500,
        },
        recordFn: async () => events.push('record'),
        scrollFn: async () => events.push('scroll'),
    });

    assert.deepEqual(events, ['waitForSelector', 'click', 'record', 'scroll']);
});

test('capturePage continues when the pre-capture selector is invalid', async () => {
    const warnings = [];
    const originalWarning = log.warning;
    log.warning = (message) => warnings.push(message);

    try {
        const events = [];
        const page = {
            waitForSelector: async () => {
                throw new Error('missing');
            },
            click: async () => events.push('click'),
        };

        await capturePage({
            page,
            gif: {},
            viewportHeight: 100,
            scrollDown: true,
            clickSelector: '#missing',
            captureConfig: {
                frameRate: 7,
                scrollPercentage: 10,
                recordingTimeBeforeAction: 1000,
                recordingTimeAfterClick: 500,
            },
            recordFn: async () => events.push('record'),
            scrollFn: async () => events.push('scroll'),
        });

        assert.deepEqual(events, ['record', 'scroll']);
        assert.equal(warnings.length, 1);
    } finally {
        log.warning = originalWarning;
    }
});

test('capturePage uses recordingTimeAfterClick before scrolling', async () => {
    const recordingTimes = [];
    const page = {
        waitForSelector: async () => {},
        click: async () => {},
    };

    await capturePage({
        page,
        gif: {},
        viewportHeight: 100,
        scrollDown: true,
        clickSelector: '#age-yes',
        captureConfig: {
            frameRate: 7,
            scrollPercentage: 10,
            recordingTimeBeforeAction: 1000,
            recordingTimeAfterClick: 250,
        },
        recordFn: async (_page, _gif, recordingTime) => {
            recordingTimes.push(recordingTime);
        },
        scrollFn: async () => {},
    });

    assert.deepEqual(recordingTimes, [250]);
});

test('capturePage returns completion metadata when scrolling is disabled', async () => {
    const page = {};

    const result = await capturePage({
        page,
        gif: {},
        viewportHeight: 100,
        scrollDown: false,
        captureConfig: {
            frameRate: 7,
            scrollPercentage: 10,
            recordingTimeBeforeAction: 1000,
            recordingTimeAfterClick: 250,
        },
        recordFn: async () => {},
    });

    assert.deepEqual(result, {
        captureCompleted: true,
        captureStopReason: 'scroll_not_requested',
        scrollStepsTaken: 0,
    });
});

test('getScrollParameters respects pageYOffset before scrollRoot offsets', async () => {
    const { page } = createMockPage({
        viewportHeight: 100,
        initialPageHeight: 500,
        pageYOffsetSequence: [80],
        scrollRootSequence: [10],
        fallbackScrollTopSequence: [5],
    });

    const parameters = await getScrollParameters({
        page,
        viewportHeight: 100,
        scrollPercentage: 50,
    });

    assert.equal(parameters.initialPosition, 180);
    assert.equal(parameters.scrollByAmount, 50);
});

test('getScrollParameters falls back to body/document offsets when pageYOffset is missing', async () => {
    const { page } = createMockPage({
        viewportHeight: 90,
        initialPageHeight: 360,
        pageYOffsetSequence: [0],
        scrollRootSequence: [0],
        fallbackScrollTopSequence: [40],
    });

    const parameters = await getScrollParameters({
        page,
        viewportHeight: 90,
        scrollPercentage: 50,
    });

    assert.equal(parameters.initialPosition, 130);
    assert.equal(parameters.scrollByAmount, 45);
});

test('scrollDownProcess refreshes page height so lazy-loaded content is captured', async () => {
    const { page, getScrollCalls, getScreenshotCount } = createMockPage({
        viewportHeight: 100,
        scrollPercentage: 50,
        initialPageHeight: 200,
        pageHeightSequence: [200, 300, 300, 300, 300],
    });
    const gif = { addFrame: () => {} };

    const result = await scrollDownProcess({
        page,
        gif,
        viewportHeight: 100,
        scrollPercentage: 50,
    });

    assert.deepEqual(getScrollCalls(), [50, 50, 50, 50]);
    assert.equal(getScreenshotCount(), 5);
    assert.deepEqual(result, {
        captureCompleted: true,
        captureStopReason: 'bottom_reached',
        scrollStepsTaken: 4,
    });
});

test('scrollDownProcess stops cleanly when the page no longer moves', async () => {
    const { page, getScrollCalls, getScreenshotCount } = createMockPage({
        viewportHeight: 100,
        scrollPercentage: 50,
        initialPageHeight: 400,
        stopMovingAfterScroll: true,
    });
    const gif = { addFrame: () => {} };

    const result = await scrollDownProcess({
        page,
        gif,
        viewportHeight: 100,
        scrollPercentage: 50,
    });

    assert.deepEqual(getScrollCalls(), [50]);
    assert.equal(getScreenshotCount(), 2);
    assert.deepEqual(result, {
        captureCompleted: false,
        captureStopReason: 'page_stopped_moving',
        scrollStepsTaken: 0,
    });
});

test('scrollDownProcess stops when the internal step limit is reached', async () => {
    const { page, getScrollCalls, getScreenshotCount } = createMockPage({
        viewportHeight: 100,
        scrollPercentage: 50,
        initialPageHeight: 2000,
    });
    const gif = { addFrame: () => {} };

    const result = await scrollDownProcess({
        page,
        gif,
        viewportHeight: 100,
        scrollPercentage: 50,
        maxScrollSteps: 2,
    });

    assert.deepEqual(getScrollCalls(), [50, 50]);
    assert.equal(getScreenshotCount(), 3);
    assert.deepEqual(result, {
        captureCompleted: false,
        captureStopReason: 'max_steps_reached',
        scrollStepsTaken: 2,
    });
});

test('scrollDownProcess stops when the internal duration limit is reached', async () => {
    const { page, getScrollCalls, getScreenshotCount } = createMockPage({
        viewportHeight: 100,
        scrollPercentage: 50,
        initialPageHeight: 2000,
    });
    const gif = { addFrame: () => {} };
    let now = 0;

    const result = await scrollDownProcess({
        page,
        gif,
        viewportHeight: 100,
        scrollPercentage: 50,
        maxScrollDurationMs: 10,
        nowFn: () => {
            now += 11;
            return now;
        },
    });

    assert.deepEqual(getScrollCalls(), []);
    assert.equal(getScreenshotCount(), 1);
    assert.deepEqual(result, {
        captureCompleted: false,
        captureStopReason: 'max_duration_reached',
        scrollStepsTaken: 0,
    });
});

test('scrollDownProcess keeps viewport-based progress independent from document height', async () => {
    const { page, getScrollCalls } = createMockPage({
        viewportHeight: 80,
        scrollPercentage: 25,
        initialPageHeight: 400,
    });
    const gif = { addFrame: () => {} };

    await scrollDownProcess({
        page,
        gif,
        viewportHeight: 80,
        scrollPercentage: 25,
    });

    assert.deepEqual(getScrollCalls(), [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20]);
});

test('createDatasetResult keeps generic and GIF-specific fields for GIF output', () => {
    const result = createDatasetResult({
        outputFormat: 'gif',
        outputUrlOriginal: 'https://example.com/original.gif',
        outputMimeType: 'image/gif',
        gifUrlOriginal: 'https://example.com/original.gif',
        gifUrlLossy: undefined,
        gifUrlLosless: undefined,
        captureCompleted: false,
        captureStopReason: 'max_steps_reached',
        scrollStepsTaken: 12,
    });

    assert.deepEqual(result, {
        outputFormat: 'gif',
        outputUrlOriginal: 'https://example.com/original.gif',
        outputMimeType: 'image/gif',
        gifUrlOriginal: 'https://example.com/original.gif',
        captureCompleted: false,
        captureStopReason: 'max_steps_reached',
        scrollStepsTaken: 12,
    });
});

test('createDatasetResult keeps compressed variants in normal mode output', () => {
    const result = createDatasetResult({
        outputFormat: 'gif',
        outputUrlOriginal: 'https://example.com/original.gif',
        outputMimeType: 'image/gif',
        gifUrlOriginal: 'https://example.com/original.gif',
        gifUrlLossy: 'https://example.com/lossy.gif',
        gifUrlLosless: 'https://example.com/lossless.gif',
        captureCompleted: true,
        captureStopReason: 'bottom_reached',
        scrollStepsTaken: 6,
    });

    assert.deepEqual(result, {
        outputFormat: 'gif',
        outputUrlOriginal: 'https://example.com/original.gif',
        outputMimeType: 'image/gif',
        gifUrlOriginal: 'https://example.com/original.gif',
        gifUrlLossy: 'https://example.com/lossy.gif',
        gifUrlLosless: 'https://example.com/lossless.gif',
        captureCompleted: true,
        captureStopReason: 'bottom_reached',
        scrollStepsTaken: 6,
    });
});

test('createDatasetResult uses video-specific fields for video output', () => {
    const result = createDatasetResult({
        outputFormat: 'webm',
        outputUrlOriginal: 'https://example.com/original.webm',
        outputMimeType: 'video/webm',
        videoUrlOriginal: 'https://example.com/original.webm',
        captureCompleted: true,
        captureStopReason: 'bottom_reached',
        scrollStepsTaken: 4,
    });

    assert.deepEqual(result, {
        outputFormat: 'webm',
        outputUrlOriginal: 'https://example.com/original.webm',
        outputMimeType: 'video/webm',
        videoUrlOriginal: 'https://example.com/original.webm',
        captureCompleted: true,
        captureStopReason: 'bottom_reached',
        scrollStepsTaken: 4,
    });
});

test('getGifBuffer resolves with the emitted GIF bytes', async () => {
    const gif = new EventEmitter();
    const chunks = [Buffer.from('gif'), Buffer.from('-bytes')];

    const gifBufferPromise = getGifBuffer(gif, chunks);
    gif.emit('end');

    const result = await gifBufferPromise;

    assert.equal(result.toString(), 'gif-bytes');
});
