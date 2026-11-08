import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../db/index';
import { criteria } from '../../../db/schema';
import { criteriaErrorLocation, parseCriteriaForm, parseToggleForm } from '../../lib/criteria-form';
import { rescoreCriteria } from '../../scoring/rescore';

export const prerender = false;

const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location } });

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const form = await request.formData();
  const db = createDb();

  if (form.get('intent') === 'toggle_active') {
    const t = parseToggleForm(form);
    if (!t.ok) return new Response('Bad request', { status: 400 });
    const rows = await db
      .update(criteria)
      .set({ active: t.active, updatedAt: new Date() })
      .where(eq(criteria.id, t.id))
      .returning({ id: criteria.id });
    if (rows.length === 0) return new Response('Not found', { status: 404 });
    await rescoreCriteria(db, t.id);
    return redirect('/criteria');
  }

  const parsed = parseCriteriaForm(form);
  if (!parsed.ok) return redirect(criteriaErrorLocation(parsed.id, parsed.error));

  const now = new Date();
  let id: number;
  if (parsed.id != null) {
    const rows = await db
      .update(criteria)
      .set({ ...parsed.values, updatedAt: now })
      .where(eq(criteria.id, parsed.id))
      .returning({ id: criteria.id });
    if (rows.length === 0) return redirect(criteriaErrorLocation(parsed.id, 'Hledání neexistuje.'));
    id = parsed.id;
  } else {
    const [row] = await db
      .insert(criteria)
      .values({ ...parsed.values, createdAt: now, updatedAt: now })
      .returning({ id: criteria.id });
    if (!row) throw new Error('criteria insert returned no row');
    id = row.id;
  }
  await rescoreCriteria(db, id);
  return redirect(`/?c=${id}`);
};
