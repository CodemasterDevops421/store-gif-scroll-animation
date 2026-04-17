## Features
Our website preview capture actor lets you turn a scrolling web page into a shareable GIF, WebM, or MP4.

The actor captures page-level scrolling across the main document, just as if you were scrolling the page yourself and recording it. But because it's automated, the pace of scrolling will be smooth.

It can be tricky to get a good recording of animations that appear when scrolling down a page. You might not scroll smoothly and the final result could look jerky or awkward. This GIF maker will automate the process, so that you just give it a URL and it will capture a wonderfully smooth animated recording of the page scrolling.

## Why use it? 
If you want to showcase your website (or any website) or share it somewhere online, you might prefer to capture a scrolling GIF. That lets you avoid problems with browser support and you embed the GIF anywhere you like, such as on social media or in comments.

The tool can also be used to visually check pages and make sure that the user experience is good. It can let you see what the page will look like to a real person scrolling down the page and highlight problems with the layout or design. The GIF maker would be especially useful if you have to do this regularly for a lot of pages, so that you can avoid manually going to each page and interacting with it in a browser.

## How it works
It's very simple to use. You give the actor a URL, it visits the web page and takes screenshots while scrolling the page itself. Those frames are then turned into a website preview asset in GIF, WebM, or MP4 format.

This actor is optimized for full-page document scrolling. It does not attempt to capture nested scrollable widgets such as drawers, modals, carousels, or embedded panels.

There are several settings you can change if you want to change the frame rate, wait before scrolling, choose the output format, compress the GIF, change the viewport, and a bunch of other customizable options. Or you can just give it a URL and go with the default settings.

If you need the result sooner, enable fast mode. Fast mode prioritizes speed over smoothness by taking fewer frames, scrolling in larger steps, and skipping extra compression outputs. For the fastest high-quality preview, use `outputFormat=mp4` or `outputFormat=webm`.

## Tutorial
Here's a [quick step-by-step guide](https://blog.apify.com/how-to-make-a-scrolling-gif-of-a-web-page/) to teach you how to make an animated scrolling GIF of any web page using GIF Scroll Animation. There's also a one-second history of the GIF and some awesome reaction GIFs to blow your mind...

## Output
### Example
Scrolling GIF for www.franshalsmuseum.nl:  

![Frans Hals Museam gif](./src/gif-examples/www.franshalsmuseum.nl-scroll_lossy-comp.gif)

### Storage
The generated preview asset is stored in the Apify key-value store. GIF remains the default output. When you choose GIF, the original GIF will always be saved and additional GIFs might also be stored if you customize the compression method. You can also find links to the generated assets in the Dataset.

For extremely long pages or pages that keep extending while scrolling, the actor may stop early and still return a usable GIF. In those cases the Dataset will include a stop reason so you can see whether the page bottom was reached or an internal safety guardrail ended the capture.

## Input parameters
| Field    | Type   | Required | Default | Description |
| -------- | ------ | -------- | ------- | ----------- |
| url      | string | Yes      |         | Website URL |
| frameRate | integer | No | 7 | Number of frames per second (fps). |
| scrollDown | boolean | Yes |  | When true, the actor will scroll down the page and capture it to create the GIF. |
| scrollPercentage | integer | No | 10 | Amount to scroll down determined as a percentage of the viewport height. (%) |
| recordingTimeBeforeAction | integer | No | 1 | Amount of time to capture the screen before doing any action like scrolling down or clicking. (ms) | 
| clickSelector | integer | No |  | Used to click an element before recording starts, for example to dismiss an age gate or open the desired page state. |
| recordingTimeAfterClick | integer | No | Amount of time to record after the pre-capture click and before scrolling begins. | 
| waitToLoadPage | integer | No | 0 | Set time to wait at the beginning so that page is fully loaded (ms). |  
| cookieWindowSelector | string | No | | CSS selector to remove cookie pop-up window if one is present. |
| slowDownAnimations | boolean | No | false |When selected, slows down animations on the page so they can be properly captured. |
| fastMode | boolean | No | false | Prioritizes quicker results with fewer frames, larger page scroll steps, and no compressed derivative outputs. |
| outputFormat | string | No | gif | Website preview output format: `gif`, `webm`, or `mp4`. Video formats skip GIF compression and usually return faster. |
| lossyCompression | boolean | No | true | Lossy LZW compression of GIF using Giflossy. |
| loslessCompression | boolean | No | false | Lossless compression of GIF using Gifsicle. |
| viewportWidth | integer | No | 1366 | Inner width of browser window (pixels) |  
| viewportHeight | integer | No | 768 | Inner height of browser window (pixels) |

### Input example
```json
{
  "url": "https://www.franshalsmuseum.nl/en/",
    "frameRate": 7,
    "scrollDown": true,
    "recordingTimeBeforeAction": 1500,
    "cookieWindowSelector": ".cookiebar"
}
```
