import { customType } from 'drizzle-orm/pg-core';

/** Coluna `bytea` mapeada para Buffer. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
