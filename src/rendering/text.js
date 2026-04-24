const LOREM = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est qui dolorem ipsum quia dolor sit amet consectetur adipisci velit. ";

function tryHyphenate(ctx, word, availWidth, minBefore = 3, minAfter = 2) {
  if (word.length < minBefore + minAfter + 1) return null;
  for (let i = word.length - minAfter; i >= minBefore; i -= 1) {
    const head = `${word.slice(0, i)}-`;
    if (ctx.measureText(head).width <= availWidth) return [head, word.slice(i)];
  }
  return null;
}

function renderJustified(ctx, words, x, lineY, w, isLast) {
  if (isLast || words.length <= 1) {
    ctx.textAlign = "left";
    ctx.fillText(words.join(" "), x, lineY);
    return;
  }

  const textWidth = words.reduce((sum, word) => sum + ctx.measureText(word).width, 0);
  const gap = (w - textWidth) / (words.length - 1);
  let currentX = x;

  for (const word of words) {
    ctx.fillText(word, currentX, lineY);
    currentX += ctx.measureText(word).width + gap;
  }
}

export function fillLorem(ctx, x, y, w, h) {
  const probe = "abcdefghijklmnopqrstuvwxyz";
  ctx.font = "12px Georgia, serif";
  const avgWidthAt12 = ctx.measureText(probe).width / probe.length;
  const fontSize = Math.max(5, Math.round(w / (60 * avgWidthAt12 / 12)));
  const leading = fontSize * 1.45;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#000";
  ctx.font = `${fontSize}px Georgia, serif`;
  ctx.textBaseline = "top";

  const source = LOREM.repeat(6).split(" ").filter(Boolean);
  const lines = [];
  let row = [];

  for (const word of source) {
    if ((lines.length + 1) * leading > h + leading) break;
    const candidate = [...row, word].join(" ");
    if (row.length > 0 && ctx.measureText(candidate).width > w) {
      const availWidth = w - ctx.measureText(`${row.join(" ")} `).width;
      const hyphenation = tryHyphenate(ctx, word, availWidth);
      if (hyphenation) {
        lines.push([...row, hyphenation[0]]);
        row = [hyphenation[1]];
      } else {
        lines.push([...row]);
        row = [word];
      }
    } else {
      row.push(word);
    }
  }

  if (row.length) lines.push(row);

  lines.forEach((lineWords, index) => {
    const lineY = y + index * leading;
    if (lineY + fontSize > y + h) return;
    renderJustified(ctx, lineWords, x, lineY, w, index === lines.length - 1);
  });

  ctx.restore();
}
