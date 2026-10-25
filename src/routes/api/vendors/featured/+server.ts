import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { vendors } from '$lib/db/schema';
import { eq, desc } from 'drizzle-orm';

export async function GET() {
  try {
    const featuredVendors = await db.select({name: vendors.name, category: vendors.category, rating: vendors.rating, order_count: vendors.order_count}).from(vendors).orderBy(desc(vendors.order_count)).limit(5);
    return json(featuredVendors);
  } catch (error) {
    console.error('Error fetching featured vendors:', error);
    return json({ error: 'Failed to fetch featured vendors' }, { status: 500 });
  }
}
