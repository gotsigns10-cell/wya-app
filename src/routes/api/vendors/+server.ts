import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { vendors } from '$lib/db/schema';
import { like } from 'drizzle-orm';

/** @type {import('./$types').RequestHandler} */
export async function GET({ url }) {
  const searchTerm = url.searchParams.get('q');

  if (!searchTerm) {
    return json({
      vendors: []
    });
  }

  const vendorResults = await db.select({ id: vendors.id, business_name: vendors.business_name, category: vendors.category, rating: vendors.rating, is_open: vendors.is_open }).from(vendors).where(like(vendors.business_name, `%${searchTerm}%`));

  const categoryResults = await db.select({ id: vendors.id, business_name: vendors.business_name, category: vendors.category, rating: vendors.rating, is_open: vendors.is_open }).from(vendors).where(like(vendors.category, `%${searchTerm}%`));

  const allResults = [...vendorResults, ...categoryResults];

  // Remove duplicates based on id
  const uniqueResults = Array.from(new Set(allResults.map(a => a.id)))
    .map(id => {
      return allResults.find(a => a.id === id)
    });


  return json({
    vendors: uniqueResults
  });
}
