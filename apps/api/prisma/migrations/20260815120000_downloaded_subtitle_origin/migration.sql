-- A subtitle fetched from an external provider.
--
-- Additive: no existing row changes value. It has to be its own origin rather
-- than reusing UPLOAD because the admin panel shows where a track came from,
-- and "uploaded" would be a lie about a file nobody chose off their own disk.
-- Like EXTRACTED, it is structurally exempt from reconcile's sidecar sweep,
-- which reaps only INGEST rows.
ALTER TYPE "MediaOrigin" ADD VALUE 'DOWNLOADED';
