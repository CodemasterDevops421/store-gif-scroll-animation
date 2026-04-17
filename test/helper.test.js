import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
    getGifBuffer,
    getScrollParameters,
    scrollDownProcess,
} from '../src/helper.js';

const ONE_BY_ONE_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
    'base64',
);

const createMockPage = ({
    pageHeight,
    clientHeight,
    scrollTop = 0,
    lazyLoadAtScrollTop,
    lazyLoadedPageHeight,
}) => {
    const state = {
        pageHeight,
        clientHeight,
        scrollTop,
    };

    const screenshots = [];
    const scrollCalls = [];

    return {
        page: {
            screenshot: async () => {
                screenshots.push(state.scrollTop);
                return ONE_BY_ONE_PNG;
            },
            evaluate: async (_fn, arg) => {
                if (typeof arg === 'number') {
                    scrollCalls.push(arg);
                    state.scrollTop += arg;

                    if (lazyLoadAtScrollTop !== undefined
                        && lazyLoadedPageHeight !== undefined
                        && state.scrollTop >= lazyLoadAtScrollTop) {
                        state.pageHeight = lazyLoadedPageHeight;
                    }

                    return undefined;
                }

                return {
                    pageHeight: state.pageHeight,
                    scrollTop: state.scrollTop,
                    clientHeight: state.clientHeight,
                };
            },
        },
        getScreenshotCount: () => screenshots.length,
        getScrollCalls: () => [...scrollCalls],
    };
};

test('getScrollParameters uses the effective scroll root height for progress and step size', async () => {
    const { page } = createMockPage({
        pageHeight: 240,
        clientHeight: 40,
    });

    const parameters = await getScrollParameters({
        page,
        viewportHeight: 100,
        scrollPercentage: 50,
    });

    assert.equal(parameters.pageHeight, 240);
    assert.equal(parameters.initialPosition, 40);
    assert.equal(parameters.scrollByAmount, 20);
    assert.equal(parameters.viewportHeight, 40);
});

test('scrollDownProcess refreshes page height so lazy-loaded content is captured', async () => {
    const { page, getScreenshotCount, getScrollCalls } = createMockPage({
        pageHeight: 200,
        clientHeight: 100,
        lazyLoadAtScrollTop: 100,
        lazyLoadedPageHeight: 300,
    });
    const gif = {
        addFrame: () => {},
    };

    await scrollDownProcess({
        page,
        gif,
        viewportHeight: 100,
        scrollPercentage: 50,
    });

    assert.deepEqual(getScrollCalls(), [50, 50, 50, 50]);
    assert.equal(getScreenshotCount(), 5);
});

test('getGifBuffer resolves with the emitted GIF bytes', async () => {
    const gif = new EventEmitter();
    const chunks = [Buffer.from('gif'), Buffer.from('-bytes')];

    const gifBufferPromise = getGifBuffer(gif, chunks);
    gif.emit('end');

    const result = await gifBufferPromise;

    assert.equal(result.toString(), 'gif-bytes');
});
