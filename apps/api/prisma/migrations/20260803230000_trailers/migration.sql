-- A trailer on a video and on a collection: the YouTube **id**, never a URL.
--
-- Parsing happens at the edge (`parseYoutubeId` in packages/shared), so what
-- lands here is always eleven characters. Storing the id rather than the pasted
-- link is what keeps the embed URL — privacy host, autoplay, mute, controls —
-- a rendering decision instead of something frozen into whatever an admin had
-- in their address bar.
--
-- Plain and additive. Nothing to hand-edit this time.

ALTER TABLE "Video" ADD COLUMN "trailerYoutubeId" TEXT;
ALTER TABLE "Collection" ADD COLUMN "trailerYoutubeId" TEXT;
