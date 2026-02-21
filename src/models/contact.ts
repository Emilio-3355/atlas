import { query } from '../config/database.js';

export interface Contact {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  relationship?: string;
  notes?: string;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export async function upsertContact(
  name: string,
  phone?: string,
  email?: string,
  relationship?: string,
  notes?: string,
): Promise<Contact> {
  const result = await query(
    `INSERT INTO contacts (name, phone, email, relationship, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET
       phone = COALESCE($2, contacts.phone),
       email = COALESCE($3, contacts.email),
       relationship = COALESCE($4, contacts.relationship),
       notes = COALESCE($5, contacts.notes),
       updated_at = NOW()
     RETURNING *`,
    [name, phone, email, relationship, notes]
  );
  return mapRow(result.rows[0]);
}

export async function searchContacts(searchText: string): Promise<Contact[]> {
  const result = await query(
    `SELECT * FROM contacts
     WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR relationship ILIKE $1
     ORDER BY name LIMIT 10`,
    [`%${searchText}%`]
  );
  return result.rows.map(mapRow);
}

function mapRow(row: any): Contact {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    relationship: row.relationship,
    notes: row.notes,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
