/** Workspace-wide actions. Unknown permissions always deny. */
export const PERMISSIONS = {
 'drawing.read': ['View drawings and previews', []],
 'drawing.create': ['Create drawings', ['drawing.read']],
 'drawing.import': ['Import drawings', ['drawing.create']],
 'drawing.edit': ['Edit drawings', ['drawing.read']],
 'drawing.rename': ['Rename drawings', ['drawing.read']],
 'drawing.duplicate': ['Duplicate drawings', ['drawing.read', 'drawing.create']],
 'drawing.export': ['Export drawings', ['drawing.read']],
 'drawing.trash': ['Move drawings to Trash', ['drawing.read']],
 'trash.read': ['View Trash', ['drawing.read']],
 'drawing.restore': ['Restore drawings', ['trash.read']],
 'collection.read': ['View collections', ['drawing.read']],
 'collection.create': ['Create collections', ['collection.read']],
 'collection.rename': ['Rename collections', ['collection.read']],
 'collection.add': ['Add collection memberships', ['collection.read', 'drawing.read']],
 'collection.remove': ['Remove collection memberships', ['collection.read', 'drawing.read']],
 'collection.delete': ['Delete collections', ['collection.read']],
};
const viewer = ['drawing.read', 'collection.read'];
const destructive = ['drawing.trash', 'trash.read', 'drawing.restore', 'collection.delete'];
export function effectivePermissions(role, overrides = {}, admin = false) {
 const preset = role === 'viewer' ? viewer : ['owner','admin','editor'].includes(role)
   ? Object.keys(PERMISSIONS).filter(k => !destructive.includes(k)) : [];
 const raw = Object.fromEntries(Object.keys(PERMISSIONS).map(k => [k,
   admin || (overrides[k] === 'deny' ? false : overrides[k] === 'allow' || preset.includes(k))]));
 const access = k => Boolean(raw[k] && PERMISSIONS[k][1].every(access));
 return Object.fromEntries(Object.keys(PERMISSIONS).map(k => [k, access(k)]));
}
export function validateOverrides(role, overrides = {}) {
 for (const [key, value] of Object.entries(overrides)) {
   if (!PERMISSIONS[key] || !['allow','deny'].includes(value)) throw new Error('Invalid permission override');
 }
 const effective = effectivePermissions(role, overrides);
 for (const [key,value] of Object.entries(overrides)) {
   if (value === 'allow' && !effective[key]) throw new Error(`Missing dependencies for ${key}: ${PERMISSIONS[key][1].join(', ')}`);
 }
 return effective;
}
