import { BRAND } from "@starterkit/shared/brand";

/**
 * The logo's symbol alone (outline paths of Wikimedia Commons "Bank_Mega_2013.svg", without the lettering) for small
 * spaces such as the collapsed rail; size it by width (about 2.1 : 1), 28 px wide minimum. Coloured only by the
 * --logo-* tokens, the same in every theme and palette.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="182 0 999 476" role="img" aria-label={BRAND.name} className={className}>
      <path fill="var(--logo-yellow)" d="M 393.95,0 h 218.49 c -36.37,81.83 -72.82,163.63 -109.25,245.44 -34.16,76.77 -68.35,153.53 -102.52,230.29 -72.87,0.03 -145.74,0.02 -218.6,0.01 C 252.7,317.16 323.27,158.55 393.95,0 Z" />
      <path fill="var(--logo-orange)" d="M 612.44,0 h 0.06 c 22.89,51.55 45.92,103.04 68.8,154.6 l 0.16,0.36 c -15.61,34.05 -30.52,68.42 -45.84,102.6 -17.63,39.43 -35.12,78.93 -52.73,118.37 -3.72,7.92 -6.71,16.18 -10.97,23.83 C 548.99,348.33 526.11,296.87 503.19,245.44 539.62,163.63 576.07,81.83 612.44,0 Z" />
      <path fill="var(--logo-silver)" d="M 750.19,0 h 0.06 c 36.41,81.85 72.86,163.68 109.31,245.51 -23.11,51.46 -45.88,103.08 -68.93,154.57 C 754.11,318.43 717.85,236.67 681.46,154.96 L 681.3,154.6 C 704.39,103.12 727.28,51.55 750.19,0 Z" />
      <path fill="var(--logo-grey)" d="M 750.25,0 h 218.49 c 70.72,158.54 141.26,317.16 211.91,475.73 -72.85,0.07 -145.71,0.01 -218.56,0.03 C 927.88,399.02 893.72,322.26 859.56,245.51 823.11,163.68 786.66,81.85 750.25,0 Z" />
      <path fill="var(--logo-flame)" d="M 681.46,154.96 c 36.39,81.71 72.65,163.47 109.17,245.12 -9.78,21.49 -26.2,39.85 -46.33,52.18 -29.82,18.52 -67.91,22.72 -101.14,11.53 -31.24,-10.28 -57.72,-34.04 -71.24,-64.03 4.26,-7.65 7.25,-15.91 10.97,-23.83 17.61,-39.44 35.1,-78.94 52.73,-118.37 15.32,-34.18 30.23,-68.55 45.84,-102.6 z" />
    </svg>
  );
}
