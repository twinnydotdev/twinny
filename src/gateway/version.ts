/** The package version, injected by the build; "dev" when run from source. */
declare const __TWINNY_SERVER_VERSION__: string

export const SERVER_VERSION: string = typeof __TWINNY_SERVER_VERSION__ === "string" ? __TWINNY_SERVER_VERSION__ : "dev"
