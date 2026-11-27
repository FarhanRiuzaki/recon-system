/**
 * The only place the product name lives: `name` in full (the default page title, the logo's accessible name, error
 * sources, the authenticator issuer), `short` where room is tight (after each page's own title in the browser tab).
 */
export const BRAND = { name: "Recon Enterprise System", short: "RES" } as const;
/**
 * Whether this product offers sign-in with Google or Apple. Recon signs in with a password or the directory only
 * (owner 24 Nov: "opsi untuk login with google and apple remove aja buat di recon ini"): off hides the buttons and the
 * connected accounts card whatever the server has set up (the routes stay; without a provider set up the API refuses).
 */
export const OAUTH_SIGN_IN = false;
