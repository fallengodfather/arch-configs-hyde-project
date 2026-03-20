'use strict'
/* eslint-env browser */
/* globals chrome, Wappalyzer, Utils */

const {
  setTechnologies,
  setCategories,
  analyze,
  analyzeManyToMany,
  resolve,
  getTechnology,
  getTechnologiesByTypes,
} = Wappalyzer
const { agent, promisify, getOption, setOption, open, close, globEscape } =
  Utils

const expiry = 1000 * 60 * 60 * 48

const maxHostnames = 100
const maxExternalScriptChars = 100000
const persistDebounce = 1000

const hostnameIgnoreList =
  /\b((local|dev(elop(ment)?)?|sandbox|stag(e|ing)?|preprod|production|preview|internal|test(ing)?|[^a-z]demo(shop)?|cache)[.-]|dev\d|localhost|((wappalyzer|google|bing|baidu|microsoft|duckduckgo|facebook|adobe|twitter|reddit|yahoo|wikipedia|amazon|amazonaws|youtube|stackoverflow|github|stackexchange|w3schools|twitch)\.)|(live|office|herokuapp|shopifypreview)\.com|\.local|\.test|\.netlify\.app|ngrok|web\.archive\.org|zoom\.us|^([0-9.]+|[\d.]+)$|^([a-f0-9:]+:+)+[a-f0-9]+$)/

const xhrDebounce = []

let xhrAnalyzed = {}

let initDone

const initPromise = new Promise((resolve) => {
  initDone = resolve
})

function getRequiredTechnologies(name, categoryId) {
  return name
    ? Wappalyzer.requires.find(({ name: _name }) => _name === name).technologies
    : categoryId
    ? Wappalyzer.categoryRequires.find(
        ({ categoryId: _categoryId }) => _categoryId === categoryId
      ).technologies
    : undefined
}

function isSimilarUrl(a, b) {
  const normalise = (url) => String(url || '').replace(/(\/|\/?#.+)$/, '')

  return normalise(a) === normalise(b)
}

function hasValues(value) {
  if (Array.isArray(value)) {
    return value.length > 0
  }

  if (value && value.constructor === Object) {
    return Object.keys(value).length > 0
  }

  return !!value
}

function getItemTypes(items) {
  return Object.keys(items).filter((type) => hasValues(items[type]))
}

async function fetchTextSnippet(url, maxChars = maxExternalScriptChars) {
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Failed to fetch script: ${response.status} ${url}`)
  }

  if (!response.body || !response.body.getReader) {
    return (await response.text()).slice(0, maxChars)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''

  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      text += decoder.decode(value, { stream: true })
    }

    text += decoder.decode()
  } finally {
    reader.cancel().catch(() => {})
  }

  return text.slice(0, maxChars)
}

const optionCache = new Map()

async function getCachedOption(name, defaultValue = null) {
  if (optionCache.has(name)) {
    return optionCache.get(name)
  }

  const value = await getOption(name, defaultValue)

  optionCache.set(name, value)

  return value
}

function setCachedOption(name, value) {
  optionCache.set(name, value)

  return setOption(name, value)
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return
  }

  Object.keys(changes).forEach((name) => {
    if ('newValue' in changes[name]) {
      optionCache.set(name, changes[name].newValue)
    } else {
      optionCache.delete(name)
    }
  })
})

const Driver = {
  persistTimer: null,

  /**
   * Initialise driver
   */
  async init() {
    await Driver.loadTechnologies()

    const hostnameCache = await getCachedOption('hostnames', {})
    const hostnames = {}

    for (const hostname of Object.keys(hostnameCache)) {
      hostnames[hostname] = {
        ...hostnameCache[hostname],
        detections: hostnameCache[hostname].detections.map(
          ({ technology: name, pattern: { regex, confidence }, version }) => ({
            technology: getTechnology(name, true),
            pattern: {
              regex: new RegExp(regex, 'i'),
              confidence,
            },
            version,
          })
        ),
      }
    }

    Driver.cache = {
      hostnames,
      robots: await getCachedOption('robots', {}),
    }

    const { version } = chrome.runtime.getManifest()
    const previous = await getCachedOption('version')
    const upgradeMessage = await getCachedOption('upgradeMessage', true)

    await setCachedOption('version', version)

    const current = await getCachedOption('version')

    if (!previous) {
      await Driver.clearCache()

      if (current) {
        open(
          'https://www.wappalyzer.com/installed/?utm_source=installed&utm_medium=extension&utm_campaign=wappalyzer'
        )

        const termsAccepted =
          agent === 'chrome' || (await getCachedOption('termsAccepted', false))

        if (!termsAccepted) {
          open(chrome.runtime.getURL('html/terms.html'))
        }
      }
    } else if (current && current !== previous && upgradeMessage) {
      open(
        `https://www.wappalyzer.com/upgraded/?utm_source=upgraded&utm_medium=extension&utm_campaign=wappalyzer`,
        false
      )
    }

    initDone()
  },

  closeCurrentTab(tabId) {
    close(tabId)
  },

  /**
   * Log debug messages to the console
   * @param {String} message
   * @param {String} source
   * @param {String} type
   */
  log(message, source = 'driver', type = 'log') {
    // eslint-disable-next-line no-console
    console[type](message)
  },

  /**
   * Log errors to the console
   * @param {String} error
   * @param {String} source
   */
  error(error, source = 'driver') {
    Driver.log(error, source, 'error')
  },

  getTechnologiesForItems(items, requires, categoryRequires) {
    return (
      getRequiredTechnologies(requires, categoryRequires) ||
      getTechnologiesByTypes(getItemTypes(items))
    )
  },

  pruneHostnamesCache() {
    Driver.cache.hostnames = Object.fromEntries(
      Object.entries(Driver.cache.hostnames)
        .sort(([, a], [, b]) => (a.dateTime > b.dateTime ? -1 : 1))
        .filter(
          ([, cache], index) =>
            cache.dateTime > Date.now() - expiry && index < maxHostnames
        )
    )
  },

  async persistHostnames() {
    Driver.pruneHostnamesCache()

    const hostnames = {}

    for (const hostname of Object.keys(Driver.cache.hostnames)) {
      const cache = Driver.cache.hostnames[hostname]

      hostnames[hostname] = {
        ...cache,
        detections: cache.detections
          .filter(({ technology }) => technology)
          .map(
            ({
              technology: { name: technology },
              pattern: { regex, confidence },
              version,
              rootPath,
              lastUrl,
            }) => ({
              technology,
              pattern: {
                regex: regex.source,
                confidence,
              },
              version,
              rootPath,
              lastUrl,
            })
          ),
      }
    }

    await setCachedOption('hostnames', hostnames)
  },

  scheduleCachePersist() {
    clearTimeout(Driver.persistTimer)

    Driver.persistTimer = setTimeout(() => {
      Driver.persistTimer = null
      Driver.persistHostnames().catch(Driver.error)
    }, persistDebounce)
  },

  /**
   * Load technologies and categories into memory
   */
  async loadTechnologies() {
    try {
      const categories = await (
        await fetch(chrome.runtime.getURL('categories.json'))
      ).json()

      const technologies = {}
      const technologyData = await Promise.all(
        Array.from({ length: 27 }, async (_, index) => {
          const character = index ? String.fromCharCode(index + 96) : '_'

          return (
            await fetch(chrome.runtime.getURL(`technologies/${character}.json`))
          ).json()
        })
      )

      technologyData.forEach((data) => Object.assign(technologies, data))

      Object.keys(technologies).forEach((name) => {
        delete technologies[name].description
        delete technologies[name].cpe
        delete technologies[name].pricing
        delete technologies[name].website
      })

      setTechnologies(technologies)
      setCategories(categories)
    } catch (error) {
      Driver.error(error)
    }
  },

  /**
   * Get all categories
   */
  getCategories() {
    return Wappalyzer.categories
  },

  /**
   * Perform a HTTP POST request
   * @param {String} url
   * @param {String} body
   */
  post(url, body) {
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
      },
    })
  },

  /**
   * Wrapper for analyze
   */
  analyze(...args) {
    return analyze(...args)
  },

  /**
   * Analyse JavaScript variables
   * @param {String} url
   * @param {Array} js
   */
  analyzeJs(url, js, requires, categoryRequires) {
    const technologies =
      getRequiredTechnologies(requires, categoryRequires) ||
      Wappalyzer.technologies
    const technologiesByName = Object.fromEntries(
      technologies.map((technology) => [technology.name, technology])
    )

    return Driver.onDetect(
      url,
      js
        .map(({ name, chain, value }) => {
          const technology = technologiesByName[name]

          return technology
            ? analyzeManyToMany(technology, 'js', { [chain]: [value] })
            : []
        })
        .flat()
    )
  },

  /**
   * Analyse DOM nodes
   * @param {String} url
   * @param {Array} dom
   */
  analyzeDom(url, dom, requires, categoryRequires) {
    const technologies =
      getRequiredTechnologies(requires, categoryRequires) ||
      Wappalyzer.technologies
    const technologiesByName = Object.fromEntries(
      technologies.map((technology) => [technology.name, technology])
    )

    return Driver.onDetect(
      url,
      dom
        .map(
          (
            { name, selector, exists, text, property, attribute, value },
            index
          ) => {
            const technology = technologiesByName[name]

            if (!technology) {
              return []
            }

            if (typeof exists !== 'undefined') {
              return analyzeManyToMany(technology, 'dom.exists', {
                [selector]: [''],
              })
            }

            if (typeof text !== 'undefined') {
              return analyzeManyToMany(technology, 'dom.text', {
                [selector]: [text],
              })
            }

            if (typeof property !== 'undefined') {
              return analyzeManyToMany(
                technology,
                `dom.properties.${property}`,
                {
                  [selector]: [value],
                }
              )
            }

            if (typeof attribute !== 'undefined') {
              return analyzeManyToMany(
                technology,
                `dom.attributes.${attribute}`,
                {
                  [selector]: [value],
                }
              )
            }
          }
        )
        .flat()
    )
  },

  /**
   * Force a technology detection by URL and technology name
   * @param {String} url
   * @param {String} name
   */
  detectTechnology(url, name) {
    const technology = getTechnology(name)

    return Driver.onDetect(url, [
      { technology, pattern: { regex: '', confidence: 100 }, version: '' },
    ])
  },

  /**
   * Enable scripts to call Driver functions through messaging
   * @param {Object} message
   * @param {Object} sender
   * @param {Function} callback
   */
  onMessage({ source, func, args }, sender, callback) {
    if (!func) {
      return
    }

    if (func === 'closeCurrentTab') {
      args = [sender.tab.id]
    }

    if (func !== 'log') {
      Driver.log({ source, func, args })
    }

    if (!Driver[func]) {
      Driver.error(new Error(`Method does not exist: Driver.${func}`))

      return
    }

    // eslint-disable-next-line no-async-promise-executor
    new Promise(async (resolve) => {
      await initPromise

      resolve(Driver[func].call(Driver[func], ...(args || [])))
    })
      .then(callback)
      .catch(Driver.error)

    return !!callback
  },

  async content(url, func, args) {
    const [tab] = await promisify(chrome.tabs, 'query', {
      url: globEscape(url),
    })

    if (!tab) {
      return
    }

    if (tab.status !== 'complete') {
      throw new Error(`Tab ${tab.id} not ready for sendMessage: ${tab.status}`)
    }

    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tab.id,
        {
          source: 'driver.js',
          func,
          args: args ? (Array.isArray(args) ? args : [args]) : [],
        },
        (response) => {
          chrome.runtime.lastError
            ? func === 'error'
              ? resolve()
              : Driver.error(
                  new Error(
                    `${
                      chrome.runtime.lastError.message
                    }: Driver.${func}(${JSON.stringify(args)})`
                  )
                )
            : resolve(response)
        }
      )
    })
  },

  /**
   * Analyse response headers
   * @param {Object} request
   */
  async onWebRequestComplete(request) {
    if (request.responseHeaders) {
      if (await Driver.isDisabledDomain(request.url)) {
        return
      }

      const headers = {}

      try {
        await new Promise((resolve) => setTimeout(resolve, 500))

        const [tab] = await promisify(chrome.tabs, 'query', {
          url: globEscape(request.url),
        })

        if (tab) {
          request.responseHeaders.forEach((header) => {
            const name = header.name.toLowerCase()

            headers[name] = headers[name] || []

            headers[name].push(
              (header.value || header.binaryValue || '').toString()
            )
          })

          Driver.onDetect(
            request.url,
            analyze({ headers }, getTechnologiesByTypes(['headers']))
          ).catch(Driver.error)
        }
      } catch (error) {
        Driver.error(error)
      }
    }
  },

  /**
   * Analyse scripts
   * @param {Object} request
   */
  async onScriptRequestComplete(request) {
    const initiatorUrl = request.initiator || request.documentUrl || request.url

    if (
      (await Driver.isDisabledDomain(initiatorUrl)) ||
      (await Driver.isDisabledDomain(request.url))
    ) {
      return
    }

    const { hostname } = new URL(initiatorUrl)

    if (!Driver.cache.hostnames[hostname]) {
      Driver.cache.hostnames[hostname] = {}
    }

    if (!Driver.cache.hostnames[hostname].analyzedScripts) {
      Driver.cache.hostnames[hostname].analyzedScripts = []
    }

    if (
      Driver.cache.hostnames[hostname].analyzedScripts.includes(request.url)
    ) {
      return
    }

    if (Driver.cache.hostnames[hostname].analyzedScripts.length >= 25) {
      return
    }

    Driver.cache.hostnames[hostname].analyzedScripts.push(request.url)

    try {
      const scripts = await fetchTextSnippet(request.url)

      Driver.onDetect(
        initiatorUrl,
        analyze({ scripts }, getTechnologiesByTypes(['scripts']))
      ).catch(Driver.error)
    } catch (error) {
      Driver.error(error)
    }
  },

  /**
   * Analyse XHR request hostnames
   * @param {Object} request
   */
  async onXhrRequestComplete(request) {
    if (await Driver.isDisabledDomain(request.url)) {
      return
    }

    let hostname
    let originHostname

    try {
      ;({ hostname } = new URL(request.url))
      ;({ hostname: originHostname } = new URL(request.originUrl))
    } catch (error) {
      return
    }

    if (!xhrDebounce.includes(hostname)) {
      xhrDebounce.push(hostname)

      setTimeout(() => {
        xhrDebounce.splice(xhrDebounce.indexOf(hostname), 1)

        xhrAnalyzed[originHostname] = xhrAnalyzed[originHostname] || []

        if (!xhrAnalyzed[originHostname].includes(hostname)) {
          xhrAnalyzed[originHostname].push(hostname)

          if (Object.keys(xhrAnalyzed).length > 500) {
            xhrAnalyzed = {}
          }

          Driver.onDetect(
            request.originUrl || request.initiator,
            analyze({ xhr: hostname }, getTechnologiesByTypes(['xhr']))
          ).catch(Driver.error)
        }
      }, 1000)
    }
  },

  /**
   * Process return values from content.js
   * @param {String} url
   * @param {Object} items
   * @param {String} language
   */
  async onContentLoad(url, items, language, requires, categoryRequires) {
    try {
      items.cookies = items.cookies || {}

      //
      ;(
        await promisify(chrome.cookies, 'getAll', {
          url,
        })
      ).forEach(
        ({ name, value }) => (items.cookies[name.toLowerCase()] = [value])
      )

      // Change Google Analytics 4 cookie from _ga_XXXXXXXXXX to _ga_*
      Object.keys(items.cookies).forEach((name) => {
        if (/_ga_[A-Z0-9]+/.test(name)) {
          items.cookies['_ga_*'] = items.cookies[name]

          delete items.cookies[name]
        }
      })

      const technologies = Driver.getTechnologiesForItems(
        { url, ...items },
        requires,
        categoryRequires
      )

      await Driver.onDetect(
        url,
        analyze({ url, ...items }, technologies),
        language,
        true
      )
    } catch (error) {
      Driver.error(error)
    }
  },

  /**
   * Get all technologies
   */
  getTechnologies() {
    return Wappalyzer.technologies
  },

  /**
   * Check if Wappalyzer has been disabled for the domain
   */
  async isDisabledDomain(url) {
    try {
      const { hostname } = new URL(url)

      return (await getCachedOption('disabledDomains', [])).includes(hostname)
    } catch (error) {
      return false
    }
  },

  /**
   * Callback for detections
   * @param {String} url
   * @param {Array} detections
   * @param {String} language
   * @param {Boolean} incrementHits
   */
  onDetect(url, detections = [], language, incrementHits = false) {
    if (!url || !detections.length) {
      return Promise.resolve()
    }

    url = url.split('#')[0]

    const { hostname, pathname } = new URL(url)

    // Cache detections
    const cache = (Driver.cache.hostnames[hostname] = {
      detections: [],
      hits: incrementHits ? 0 : 1,
      https: url.startsWith('https://'),
      analyzedScripts: [],
      ...(Driver.cache.hostnames[hostname] || []),
      dateTime: Date.now(),
    })

    // Remove duplicates
    cache.detections = cache.detections
      .concat(detections)
      .filter(({ technology }) => technology)
      .filter(
        (
          {
            technology: { name },
            pattern: { regex, value },
            confidence,
            version,
          },
          index,
          detections
        ) =>
          detections.findIndex(
            ({
              technology: { name: _name },
              pattern: { regex: _regex, value: _value },
              confidence: _confidence,
              version: _version,
            }) =>
              name === _name &&
              version === _version &&
              confidence === _confidence &&
              value === _value &&
              (!regex || regex.toString() === _regex.toString())
          ) === index
      )
      .map((detection) => {
        if (
          detections.find(
            ({ technology: { slug } }) => slug === detection.technology.slug
          )
        ) {
          detection.lastUrl = url
        }

        return detection
      })

    // Track if technology was identified on website's root path
    detections.forEach(({ technology: { name } }) => {
      const detection = cache.detections.find(
        ({ technology: { name: _name } }) => name === _name
      )

      detection.rootPath = detection.rootPath || pathname === '/'
    })

    const resolved = resolve(cache.detections).map((detection) => detection)

    // Look for technologies that require other technologies to be present on the page
    const requires = [
      ...Wappalyzer.requires.filter(({ name }) =>
        resolved.some(({ name: _name }) => _name === name)
      ),
      ...Wappalyzer.categoryRequires.filter(({ categoryId }) =>
        resolved.some(({ categories }) =>
          categories.some(({ id }) => id === categoryId)
        )
      ),
    ]

    cache.hits += incrementHits ? 1 : 0
    cache.language = cache.language || language

    Driver.pruneHostnamesCache()
    Driver.scheduleCachePersist()

    Driver.content(url, 'analyzeRequires', [url, requires]).catch(() => {})
    Driver.setIcon(url, resolved).catch(Driver.error)
    Driver.ping().catch(Driver.error)

    Driver.log({ hostname, technologies: resolved })

    return Promise.resolve()
  },

  /**
   * Update the extension icon
   * @param {String} url
   * @param {Object} technologies
   */
  async setIcon(url, technologies = []) {
    if (await Driver.isDisabledDomain(url)) {
      technologies = []
    }

    const dynamicIcon = await getCachedOption('dynamicIcon', false)
    const showCached = await getCachedOption('showCached', true)
    const badge = await getCachedOption('badge', true)

    let icon = 'default.svg'

    const _technologies = technologies.filter(
      ({ slug, lastUrl }) =>
        slug !== 'cart-functionality' &&
        (showCached || isSimilarUrl(url, lastUrl))
    )

    if (dynamicIcon) {
      const pinnedCategory = parseInt(
        await getCachedOption('pinnedCategory'),
        10
      )

      const pinned = _technologies.find(({ categories }) =>
        categories.some(({ id }) => id === pinnedCategory)
      )

      ;({ icon } = pinned || _technologies[0] || { icon })
    }

    if (!url) {
      return
    }

    let tabs = []

    try {
      tabs = await promisify(chrome.tabs, 'query', {
        url: globEscape(url),
      })
    } catch (error) {
      // Continue
    }

    tabs.forEach(({ id: tabId }) => {
      chrome.action.setBadgeText(
        {
          tabId,
          text:
            badge && _technologies.length
              ? _technologies.length.toString()
              : '',
        },
        () => {}
      )

      chrome.action.setIcon(
        {
          tabId,
          path: chrome.runtime.getURL(
            `../images/icons/${
              /\.svg$/i.test(icon)
                ? `converted/${icon.replace(/\.svg$/, '.png')}`
                : icon
            }`
          ),
        },
        () => {}
      )
    })
  },

  /**
   * Get the detected technologies for the current tab
   */
  async getDetections() {
    const [tab] = await promisify(chrome.tabs, 'query', {
      active: true,
      currentWindow: true,
    })

    if (!tab) {
      Driver.error(new Error('getDetections: no active tab found'))

      return
    }

    const { url } = tab

    if (await Driver.isDisabledDomain(url)) {
      await Driver.setIcon(url, [])

      return
    }

    const showCached = await getCachedOption('showCached', true)

    const { hostname } = new URL(url)

    const cache = Driver.cache.hostnames?.[hostname]

    const resolved = (cache ? resolve(cache.detections) : []).filter(
      ({ lastUrl }) => showCached || isSimilarUrl(url, lastUrl)
    )

    await Driver.setIcon(url, resolved)

    return resolved
  },

  /**
   * Fetch the website's robots.txt rules
   * @param {String} hostname
   * @param {Boolean} secure
   */
  async getRobots(hostname, secure = false) {
    if (
      !(await getCachedOption('tracking', true)) ||
      hostnameIgnoreList.test(hostname)
    ) {
      return []
    }

    if (typeof Driver.cache.robots[hostname] !== 'undefined') {
      return Driver.cache.robots[hostname]
    }

    try {
      Driver.cache.robots[hostname] = await Promise.race([
        // eslint-disable-next-line no-async-promise-executor
        new Promise(async (resolve) => {
          const response = await fetch(
            `http${secure ? 's' : ''}://${hostname}/robots.txt`
          )

          if (!response.ok) {
            Driver.log(`getRobots: ${response.statusText} (${hostname})`)

            resolve('')
          }

          let agent

          resolve(
            (await response.text()).split('\n').reduce((disallows, line) => {
              let matches = /^User-agent:\s*(.+)$/i.exec(line.trim())

              if (matches) {
                agent = matches[1].toLowerCase()
              } else if (agent === '*' || agent === 'wappalyzer') {
                matches = /^Disallow:\s*(.+)$/i.exec(line.trim())

                if (matches) {
                  disallows.push(matches[1])
                }
              }

              return disallows
            }, [])
          )
        }),
        new Promise((resolve) => setTimeout(() => resolve(''), 5000)),
      ])

      Driver.cache.robots = Object.keys(Driver.cache.robots)
        .slice(-50)
        .reduce(
          (cache, hostname) => ({
            ...cache,
            [hostname]: Driver.cache.robots[hostname],
          }),
          {}
        )

      await setCachedOption('robots', Driver.cache.robots)

      return Driver.cache.robots[hostname]
    } catch (error) {
      Driver.error(error)
    }
  },

  /**
   * Check if the website allows indexing of a URL
   * @param {String} href
   */
  async checkRobots(href) {
    const url = new URL(href)

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Invalid protocol')
    }

    const robots = await Driver.getRobots(
      url.hostname,
      url.protocol === 'https:'
    )

    if (robots.some((disallowed) => url.pathname.indexOf(disallowed) === 0)) {
      throw new Error('Disallowed')
    }
  },

  /**
   * Clear caches
   */
  async clearCache() {
    clearTimeout(Driver.persistTimer)
    Driver.persistTimer = null
    Driver.cache.hostnames = {}

    xhrAnalyzed = {}

    await setCachedOption('hostnames', {})
  },

  /**
   * Anonymously send identified technologies to wappalyzer.com
   * This function can be disabled in the extension settings
   */
  async ping() {
    const tracking = await getCachedOption('tracking', true)
    const termsAccepted =
      agent === 'chrome' || (await getCachedOption('termsAccepted', false))

    if (tracking && termsAccepted) {
      const urls = Object.keys(Driver.cache.hostnames).reduce(
        (urls, hostname) => {
          if (Object.keys(urls).length >= 25) {
            return urls
          }

          // eslint-disable-next-line standard/computed-property-even-spacing
          const { language, detections, hits, https } =
            Driver.cache.hostnames[hostname]

          const url = `http${https ? 's' : ''}://${hostname}`

          if (!hostnameIgnoreList.test(hostname) && hits) {
            urls[url] = urls[url] || {
              technologies: resolve(detections).reduce(
                (technologies, { name, confidence, version, rootPath }) => {
                  if (confidence === 100) {
                    technologies[name] = {
                      version,
                      hits,
                      rootPath,
                    }
                  }

                  return technologies
                },
                {}
              ),
              meta: {
                language,
              },
            }
          }

          return urls
        },
        {}
      )

      const count = Object.keys(urls).length

      const lastPing = await getCachedOption('lastPing', Date.now())

      if (
        count &&
        ((count >= 25 && lastPing < Date.now() - 1000 * 60 * 60) ||
          (count >= 5 && lastPing < Date.now() - expiry))
      ) {
        await setCachedOption('lastPing', Date.now())

        try {
          await Driver.post('https://ping.wappalyzer.com/v2/', {
            version: chrome.runtime.getManifest().version,
            urls,
          })
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(error)
        }

        Object.keys(Driver.cache.hostnames).forEach((hostname) => {
          Driver.cache.hostnames[hostname].hits = 0
        })
      }
    }
  },
}

chrome.action.setBadgeBackgroundColor({ color: '#6B39BD' }, () => {})

chrome.webRequest.onCompleted.addListener(
  Driver.onWebRequestComplete,
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders']
)

chrome.webRequest.onCompleted.addListener(Driver.onScriptRequestComplete, {
  urls: ['http://*/*', 'https://*/*'],
  types: ['script'],
})

chrome.webRequest.onCompleted.addListener(Driver.onXhrRequestComplete, {
  urls: ['http://*/*', 'https://*/*'],
  types: ['xmlhttprequest'],
})

chrome.tabs.onUpdated.addListener(async (id, { status, url }) => {
  if (status === 'complete') {
    ;({ url } = await promisify(chrome.tabs, 'get', id))
  }

  if (url) {
    const { hostname } = new URL(url)

    const showCached = await getCachedOption('showCached', true)

    const cache = Driver.cache?.hostnames?.[hostname]

    const resolved = (cache ? resolve(cache.detections) : []).filter(
      ({ lastUrl }) => showCached || isSimilarUrl(url, lastUrl)
    )

    await Driver.setIcon(url, resolved)
  }
})

// Enable messaging between scripts
chrome.runtime.onMessage.addListener(Driver.onMessage)

Driver.init()
