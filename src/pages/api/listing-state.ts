import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../db/index';
import { listing, listingState } from '../../../db/schema';
import { parseListingStateForm } from '../../lib/listing-state-form';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  const p = parseListingStateForm(await request.formData());
  if (!p.ok) return new Response('Bad request', { status: 400 });

  const db = createDb();
  const [exists] = await db.select({ id: listing.id }).from(listing).where(eq(listing.id, p.listingId));
  if (!exists) return new Response('Not found', { status: 404 });

  const now = new Date();
  const note = p.note === undefined ? {} : { note: p.note === '' ? null : p.note };
  await db
    .insert(listingState)
    .values({ listingId: p.listingId, status: p.status, updatedAt: now, ...note })
    .onConflictDoUpdate({
      target: listingState.listingId,
      set: { status: p.status, updatedAt: now, ...note },
    });
  return new Response(null, { status: 303, headers: { Location: p.next } });
};
