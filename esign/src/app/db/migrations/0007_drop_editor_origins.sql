-- ESIGN_FRAME_ANCESTORS is gone: each embedded page is bound to the origin its host names, so the deployment-wide
-- list it was synced into is unused. Safe to run again.
DELETE FROM `app_settings` WHERE `name` = 'editor_origins';
