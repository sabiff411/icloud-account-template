import { useEffect, useMemo, useState } from "react";
import { getMarks, setMark, thumbUrl } from "./api.js";
import { BALANCE_LABEL } from "./marks.js";
import ImageMenu from "./ImageMenu.jsx";
import Lightbox from "./Lightbox.jsx";
import RetryImage from "./RetryImage.jsx";

/* Every starred photo, across all accounts.  The marks file is the source of
 * truth (`favorite: true`), so an image starred in one account shows up here
 * with its own thumbnail and can be un-starred in place. */

export default function FavoritesTab({ admin }) {
  const accounts = admin?.state?.accounts || [];
  const [marks, setMarks] = useState({});
  const [menu, setMenu] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const byEmail = useMemo(() => {
    const map = new Map();
    for (const account of accounts) map.set(String(account.email).toLowerCase(), account.id);
    return map;
  }, [accounts]);

  useEffect(() => {
    let alive = true;
    getMarks({ favorite: 1 })
      .then((data) => {
        if (alive) setMarks(data?.marks || {});
      })
      .catch((failure) => alive && setError(failure.message));
    return () => {
      alive = false;
    };
  }, [tick]);

  const items = useMemo(
    () =>
      Object.entries(marks)
        .map(([key, entry]) => {
          const slash = key.indexOf("/");
          const email = key.slice(0, slash);
          const path = key.slice(slash + 1);
          return {
            email,
            path,
            name: path.split("/").pop() || path,
            accountId: byEmail.get(email) || "",
            entry,
          };
        })
        .filter((item) => item.accountId)
        .sort((a, b) => a.email.localeCompare(b.email) || a.path.localeCompare(b.path)),
    [marks, byEmail]
  );

  async function pick(item, patch) {
    setMenu(null);
    try {
      await setMark({ email: item.email, path: item.path, ...patch });
      setTick((value) => value + 1);
    } catch (failure) {
      setError(failure.message);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-[#1d1d1f]">Favourites</h2>
        <span className="text-[12px] text-[#6e6e73]">
          {items.length.toLocaleString()} starred
        </span>
      </div>
      <p className="mt-1 text-[11px] text-[#6e6e73]">
        Right-click a photo in any account and choose <b>Favourite</b>. Right-click here to remove
        it, change the tag or the balance.
      </p>

      {error ? (
        <p className="mt-3 rounded-[8px] bg-[#fff2f2] px-3 py-2 text-[12px] text-[#c4000a]">{error}</p>
      ) : null}

      {items.length === 0 ? (
        <p className="mt-6 rounded-[12px] border border-dashed border-[#d8d8de] px-6 py-10 text-center text-[12px] text-[#6e6e73]">
          Nothing starred yet.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((item, index) => (
            <button
              key={`${item.accountId}/${item.path}`}
              type="button"
              onClick={() => setOpen(index)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({ x: event.clientX, y: event.clientY, item });
              }}
              className="group overflow-hidden rounded-[10px] border border-[#e5e5ea] bg-white text-left transition hover:border-[#f0b429] hover:shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
            >
              <div className="relative aspect-square bg-[#f5f5f7]">
                <RetryImage
                  loading="lazy"
                  decoding="async"
                  src={thumbUrl(item.accountId, item.path)}
                  alt={item.name}
                  className="h-full w-full object-cover"
                />
                <span className="absolute right-1 top-1 flex flex-col items-end gap-0.5">
                  {item.entry.mark ? (
                    <span className="rounded bg-black/70 px-1 text-[9px] font-semibold uppercase text-white">
                      {item.entry.mark}
                    </span>
                  ) : null}
                  {item.entry.balance ? (
                    <span className="rounded bg-[#1d1d1f]/85 px-1 text-[9px] font-semibold text-white">
                      {BALANCE_LABEL[item.entry.balance] || item.entry.balance}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="px-2 py-1.5">
                <div className="truncate text-[11px] font-medium text-[#1d1d1f]" title={item.name}>
                  {item.name}
                </div>
                <div className="truncate text-[10px] text-[#6e6e73]">{item.email}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {open !== null ? (
        <Lightbox
          accountId={items[open]?.accountId}
          items={items}
          index={open}
          setIndex={setOpen}
          onClose={() => setOpen(null)}
        />
      ) : null}

      {menu ? (
        <ImageMenu
          x={menu.x}
          y={menu.y}
          entry={menu.item.entry}
          onClose={() => setMenu(null)}
          onPick={(patch) => pick(menu.item, patch)}
        />
      ) : null}
    </div>
  );
}
