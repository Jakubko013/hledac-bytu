import { z } from 'zod';
import { sanitizeNext } from './safe-redirect';

export const MAX_NOTE_LENGTH = 2000;

const schema = z.object({
  listing_id: z.coerce.number().int().positive().max(2_147_483_647),
  status: z.enum(['favorite', 'hidden', 'seen']),
  note: z.string().max(MAX_NOTE_LENGTH).optional(),
});

export type ListingStateParse =
  | { ok: true; listingId: number; status: 'favorite' | 'hidden' | 'seen'; note: string | undefined; next: string }
  | { ok: false };

/** `note` undefined = field not submitted (keep stored note); empty string clears it. */
export function parseListingStateForm(form: { get(name: string): FormDataEntryValue | null }): ListingStateParse {
  const noteRaw = form.get('note');
  const parsed = schema.safeParse({
    listing_id: String(form.get('listing_id') ?? ''),
    status: String(form.get('status') ?? ''),
    note: noteRaw == null ? undefined : String(noteRaw),
  });
  if (!parsed.success) return { ok: false };
  const d = parsed.data;
  return {
    ok: true,
    listingId: d.listing_id,
    status: d.status,
    note: d.note?.trim(),
    next: sanitizeNext(form.get('next')),
  };
}
