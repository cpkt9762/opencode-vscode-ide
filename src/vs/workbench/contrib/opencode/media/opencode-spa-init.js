;(() => {
	const policyName = "opencodeSidebar"
	const defaultServerUrlKey = "opencode.settings.dat:defaultServerUrl"
	const themeIdKey = "opencode-theme-id"
	const colorSchemeKey = "opencode-color-scheme"
	const themeCssLightKey = "opencode-theme-css-light"
	const themeCssDarkKey = "opencode-theme-css-dark"

	const readMeta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") || ""
	const getStorage = (key) => {
		try {
			return localStorage.getItem(key)
		} catch {
			return null
		}
	}
	const setStorage = (key, value) => {
		try {
			if (value !== null) localStorage.setItem(key, value)
		} catch {
			return
		}
	}
	const removeStorage = (key) => {
		try {
			localStorage.removeItem(key)
		} catch {
			return
		}
	}
	const wrapInnerHTML = (prototype, policy) => {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "innerHTML")
		if (!descriptor?.set) return
		Object.defineProperty(prototype, "innerHTML", {
			configurable: descriptor.configurable ?? true,
			enumerable: descriptor.enumerable ?? false,
			get: descriptor.get,
			set(value) {
				const next = typeof value === "string" ? (policy?.createHTML(value) ?? value) : value
				return descriptor.set.call(this, next)
			},
		})
	}
	const patchLocationProperty = (name, value) => {
		try {
			const descriptor = Object.getOwnPropertyDescriptor(Location.prototype, name)
			if (!descriptor?.get) return
			Object.defineProperty(Location.prototype, name, {
				configurable: true,
				enumerable: descriptor.enumerable ?? false,
				get() {
					return value
				},
			})
		} catch {
			return
		}
	}
	const normalizeServerUrl = (value) => (value.endsWith("/") ? value : `${value}/`)
	const rewriteServerUrl = (value, serverUrl) => {
		if (value === "null") return serverUrl
		if (value.startsWith("null/")) return new URL(value.slice(5), normalizeServerUrl(serverUrl)).toString()

		const nullSegment = "/null/"
		const segmentIndex = value.indexOf(nullSegment)
		if (segmentIndex !== -1) {
			return new URL(value.slice(segmentIndex + nullSegment.length), normalizeServerUrl(serverUrl)).toString()
		}

		return value
	}

	let policy
	try {
		policy = window.trustedTypes?.createPolicy?.(policyName, {
			createHTML: (value) => value,
			createScript: (value) => value,
			createScriptURL: (value) => value,
		})
	} catch (error) {
		console.warn("[opencode] Failed to create Trusted Types policy", error)
	}

	wrapInnerHTML(Element.prototype, policy)
	if (typeof ShadowRoot !== "undefined") wrapInnerHTML(ShadowRoot.prototype, policy)

	if (policy) {
		const OriginalFunction = Function
		function TrustedFunction(...args) {
			if (typeof args[args.length - 1] === "string") {
				args[args.length - 1] = policy.createScript(args[args.length - 1])
			}
			return OriginalFunction(...args)
		}
		TrustedFunction.prototype = OriginalFunction.prototype
		Object.setPrototypeOf(TrustedFunction, OriginalFunction)
		window.Function = TrustedFunction
	}

	const serverUrl = readMeta("opencode-server-url")
	if (serverUrl) {
		try {
			const url = new URL(serverUrl)
			patchLocationProperty("origin", url.origin)
			patchLocationProperty("protocol", url.protocol)
			patchLocationProperty("host", url.host)
			patchLocationProperty("hostname", url.hostname)
			patchLocationProperty("port", url.port)
		} catch {
			// Ignore malformed URLs and fall back to fetch rewriting below.
		}

		const originalFetch = window.fetch.bind(window)
		window.fetch = (input, init) => {
			if (typeof input === "string") return originalFetch(rewriteServerUrl(input, serverUrl), init)
			if (input instanceof URL) return originalFetch(rewriteServerUrl(input.toString(), serverUrl), init)
			if (input instanceof Request) {
				const rewritten = rewriteServerUrl(input.url, serverUrl)
				return rewritten === input.url ? originalFetch(input, init) : originalFetch(new Request(rewritten, input), init)
			}
			return originalFetch(input, init)
		}
	}
	if (serverUrl && !getStorage(defaultServerUrlKey)) setStorage(defaultServerUrlKey, serverUrl)

	let themeId = getStorage(themeIdKey) || "oc-2"
	if (themeId === "oc-1") {
		themeId = "oc-2"
		setStorage(themeIdKey, themeId)
		removeStorage(themeCssLightKey)
		removeStorage(themeCssDarkKey)
	}

	const storedScheme = getStorage(colorSchemeKey) || "system"
	const metaThemeType = readMeta("opencode-theme-type") || "dark"
	const isDark = storedScheme === "dark" || (storedScheme === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : metaThemeType !== "light")
	const mode = isDark ? "dark" : "light"

	document.documentElement.dataset.theme = themeId
	document.documentElement.dataset.colorScheme = mode

	const root = document.getElementById("root")
	const fallback = document.getElementById("opencode-fallback")
	if (!(root instanceof HTMLElement) || !(fallback instanceof HTMLElement)) return

	const syncFallback = () => {
		fallback.hidden = root.childElementCount > 0
	}

	new MutationObserver(syncFallback).observe(root, { childList: true, subtree: true })
	window.addEventListener("load", syncFallback, { once: true })
	setTimeout(syncFallback, 2000)
})()
