/** The only place the product name lives. */
export const BRAND = { name: "SunnyGo" } as const;
/**
 * Whether this product offers sign-in with Google or Apple. Recon signs in with a password or the directory only
 * (owner 24 Nov: "opsi untuk login with google and apple remove aja buat di recon ini"): off hides the buttons and the
 * connected accounts card whatever the server has set up (the routes stay; without a provider set up the API refuses).
 */
export const OAUTH_SIGN_IN = false;
