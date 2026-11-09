// Token HP Bars: shows how a module draws on the board.
// Players only see bars for actors they own; the GM sees all of them.
export default function init(hearth) {
  hearth.hooks.on('board:drawToken', (ctx, token, actor, rect) => {
    const hp = actor?.data?.hp;
    if (!hp || !hp.max || !hearth.ownsActor(actor.id)) return;
    const pct = Math.max(0, Math.min(1, hp.value / hp.max));
    const h = Math.max(4, rect.h * 0.08);
    const y = rect.y + rect.h - h;
    ctx.fillStyle = 'rgba(0,0,0,.7)';
    ctx.fillRect(rect.x + 4, y, rect.w - 8, h);
    ctx.fillStyle = pct > 0.5 ? '#57c785' : pct > 0.25 ? '#e0a040' : '#e05f5f';
    ctx.fillRect(rect.x + 4, y, (rect.w - 8) * pct, h);
  });
  // Redraw when an actor's HP changes.
  hearth.hooks.on('op:actor_update', () => hearth.board.invalidate());
}
