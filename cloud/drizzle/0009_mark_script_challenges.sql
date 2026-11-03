-- Preserve prior operation evidence and cooldowns. Pause only a currently retained
-- response that proves the observed script challenge; never submit or replay.
UPDATE provider_state SET blocked_code='CELLARTRACKER_BROWSER_CHALLENGE'
WHERE blocked_code IS NULL AND EXISTS (
 SELECT 1 FROM provider_error_details AS e
 WHERE e.owner=provider_state.owner AND e.expires_at>unixepoch('now')*1000
 AND CASE WHEN json_valid(e.body) THEN
  json_extract(e.body,'$.status')=429
  AND json_extract(e.body,'$.headers."x-kpsdk-r"')='1-AA'
  AND json_type(e.body,'$.headers."x-kpsdk-ct"')='text'
  AND instr(json_extract(e.body,'$.body'),'window.KPSDK')>0
  AND instr(json_extract(e.body,'$.body'),'/ips.js?')>0
 ELSE 0 END
);
