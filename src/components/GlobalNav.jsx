import { NAV_SVGS } from "./navSvgs";
import { AppleLogoCompact, SearchCompact, BagCompact } from "./Icons";

// The reference page paints the global navigation labels as SVG wordmarks, not
// text. Same paths, same intrinsic widths: each anchor is padding + the mark.
const LINKS = [
  ["store", "Store"],
  ["mac", "Mac"],
  ["ipad", "iPad"],
  ["iphone", "iPhone"],
  ["watch", "Watch"],
  ["vision", "Vision"],
  ["airpods", "AirPods"],
  ["tv-home", "TV & Home"],
  ["entertainment", "Entertainment"],
  ["accessories", "Accessories"],
  ["support", "Support"],
];

function Wordmark({ name }) {
  return <span className="flex" dangerouslySetInnerHTML={{ __html: NAV_SVGS[name] }} />;
}

export default function GlobalNav() {
  return (
    <nav id="globalnav" className="relative bg-white">
      {/* Full navigation (Apple's 44px bar) */}
      <div className="mx-auto h-[44px] max-w-[1024px] px-[22px] max-[833px]:hidden">
        <ul className="mx-[-8px] flex h-full items-center justify-between">
          <li className="h-full">
            <a
              href="#"
              aria-label="Apple"
              className="flex h-full items-center px-[8px] text-[rgba(0,0,0,0.8)] duration-200 hover:text-black"
            >
              <Wordmark name="apple" />
            </a>
          </li>
          {LINKS.map(([name, label]) => (
            <li key={name} className="h-full">
              <a
                href="#"
                aria-label={label}
                className="flex h-full items-center px-[8px] text-[rgba(0,0,0,0.8)] duration-200 hover:text-black"
              >
                <Wordmark name={name} />
              </a>
            </li>
          ))}
          <li className="h-full">
            <a
              href="#"
              aria-label="Search apple.com"
              className="flex h-full items-center px-[8px] text-[rgba(0,0,0,0.8)] duration-200 hover:text-black"
            >
              <Wordmark name="Search apple.com" />
            </a>
          </li>
          <li className="h-full">
            <a
              href="#"
              aria-label="Shopping Bag"
              className="flex h-full items-center px-[8px] text-[rgba(0,0,0,0.8)] duration-200 hover:text-black"
            >
              <Wordmark name="bag" />
            </a>
          </li>
        </ul>
      </div>

      {/* Compact navigation (48px bar) */}
      <div className="hidden h-[48px] items-center bg-white max-[833px]:flex">
        <a
          href="#"
          aria-label="Apple"
          className="flex h-[48px] w-[49px] items-center justify-center px-4 text-black"
        >
          <AppleLogoCompact />
        </a>
        <div className="ml-auto flex">
          <a
            href="#"
            aria-label="Search apple.com"
            className="flex h-[48px] w-[48px] items-center justify-center text-[rgba(0,0,0,0.8)]"
          >
            <SearchCompact />
          </a>
          <a
            href="#"
            aria-label="Shopping Bag"
            className="flex h-[48px] w-[48px] items-center justify-center text-[rgba(0,0,0,0.8)]"
          >
            <BagCompact />
          </a>
          <button
            type="button"
            aria-label="Main menu"
            className="flex h-[48px] w-[48px] items-center justify-center text-black opacity-80"
          >
            <svg width="18" height="18" viewBox="0 0 18 18">
              <polyline fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" points="2 12, 16 12" />
              <polyline fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" points="2 5, 16 5" />
            </svg>
          </button>
        </div>
      </div>
    </nav>
  );
}
