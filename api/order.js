import { randomInt } from 'crypto';

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  const res = await fetch(URL + '/get/' + encodeURIComponent(key), {
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  const j = await res.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  const res = await fetch(URL + '/set/' + encodeURIComponent(key), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value)
  });
  return res.json();
}

async function kvPush(key, value) {
  const res = await fetch(URL + '/rpush/' + encodeURIComponent(key) + '/' + encodeURIComponent(value), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  return res.json();
}

async function kvRange(key) {
  const res = await fetch(URL + '/lrange/' + encodeURIComponent(key) + '/-20/-1', {
    headers: { Authorization: 'Bearer ' + TOKEN }
  });
  const j = await res.json();
  return j.result || [];
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeId(len = 5) {
  return Array.from({ length: len }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
}

const cleanName = n => String(n || '').trim().slice(0, 30);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const id = String(req.query.id || '').toUpperCase();
      if (!id) return res.status(400).json({ error: 'missing id' });
      const order = await kvGet('order:' + id);
      if (!order) return res.status(404).json({ error: 'not found' });
      return res.status(200).json(order);
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const id = String(body.id || '').toUpperCase();

    if (action === 'create') {
      const restaurantId = String(body.restaurantId || '').slice(0, 40);
      if (!restaurantId) return res.status(400).json({ error: 'missing restaurantId' });
      const oid = makeId();
      const order = { id: oid, restaurantId, status: 'open', createdAt: Date.now(), people: {} };
      await kvSet('order:' + oid, order);
      await kvPush('orders', oid);
      return res.status(200).json({ id: oid });
    }

    if (action === 'list') {
      const ids = await kvRange('orders');
      const orders = [];
      for (const oid of ids.reverse()) {
        const o = await kvGet('order:' + oid);
        if (o) orders.push({ id: o.id, restaurantId: o.restaurantId, status: o.status, createdAt: o.createdAt, people: Object.keys(o.people || {}).reduce((m, k) => (m[k] = 1, m), {}) });
      }
      return res.status(200).json({ orders });
    }

    if (!id) return res.status(400).json({ error: 'missing id' });
    const order = await kvGet('order:' + id);
    if (!order) return res.status(404).json({ error: 'not found' });
    order.people = order.people || {};

    if (action === 'setItems') {
      const name = cleanName(body.name);
      if (!name) return res.status(400).json({ error: 'missing name' });
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map(it => ({
        itemId: String(it.itemId || '').slice(0, 40),
        name: String(it.name || '').slice(0, 80),
        price: Math.max(0, Number(it.price) || 0),
        qty: Math.min(20, Math.max(1, parseInt(it.qty) || 1)),
        note: String(it.note || '').slice(0, 80)
      })).filter(it => it.itemId && it.price >= 0);
      if (items.length === 0) delete order.people[name];
      else order.people[name] = { items, paid: order.people[name] ? !!order.people[name].paid : false, ts: Date.now() };
      await kvSet('order:' + id, order);
      return res.status(200).json({ ok: true });
    }

    if (action === 'paid') {
      const name = cleanName(body.name);
      if (!order.people[name]) return res.status(404).json({ error: 'person not found' });
      order.people[name].paid = !!body.paid;
      await kvSet('order:' + id, order);
      return res.status(200).json({ ok: true });
    }

    if (action === 'status') {
      order.status = body.status === 'closed' ? 'closed' : 'open';
      await kvSet('order:' + id, order);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e).slice(0, 200) });
  }
}
