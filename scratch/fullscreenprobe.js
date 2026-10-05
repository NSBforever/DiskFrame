/**
 * App full screen vs viewer full screen, in a running build.
 * Reads window state through the app's own API and the DOM; window.innerWidth
 * against screen.width tells whether the window really covers the screen.
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const st = async (label) => ({
    label,
    appFullscreen: await window.api.getWindowFullscreen(),
    coversScreen: window.innerWidth >= screen.width - 2 && window.innerHeight >= screen.height - 2,
    inner: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    htmlFullscreen: !!document.fullscreenElement,
    exitButton: (document.querySelector('.df-fullscreen-toggle') || {}).textContent || null,
    viewerOpen: !!document.querySelector('.media-viewer-back-btn')
  })
  const out = []
  out.push(await st('at launch'))
  await window.api.setStartFullscreen(true)
  out.push({ startPref: await window.api.getStartFullscreen() })

  // The in-app button leaves full screen, and again re-enters it.
  document.querySelector('.df-fullscreen-toggle').click()
  await sleep(900)
  out.push(await st('after Exit full screen button'))
  document.querySelector('.df-fullscreen-toggle').click()
  await sleep(900)
  out.push(await st('after Full screen button'))
  return JSON.stringify(out, null, 1)
})()
