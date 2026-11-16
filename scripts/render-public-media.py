"""Screenshot the generated current-renderer illustrations and encode their GIF sequences."""
import json,os,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image
cfg=json.loads(Path(sys.argv[1]).read_text());tmp=Path(cfg['temp']);ext=Path(cfg['ext']);out=ext/'images/store';out.mkdir(exist_ok=True)
with sync_playwright() as pw:
 browser_path=os.environ.get('CGG_MEDIA_BROWSER','/usr/bin/google-chrome')
 browser=pw.chromium.launch(headless=True,**({'executable_path':browser_path} if Path(browser_path).exists() else {}),args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':960},device_scale_factor=1)
 for scene in cfg['scenes']:
  name=scene['name'];page.goto((tmp/(name+'.html')).as_uri());page.wait_for_load_state('load');page.add_style_tag(content='*{cursor:none!important}')
  if scene.get('fill'):
   frame=page.frame_locator('iframe');frame.locator('.su-options summary').click();frame.locator('#su-goal').fill('Ship CSV export with filters and tests')
   frame.locator('#su-crit').fill('Export only the filtered rows');frame.locator('#su-crit').press('Enter')
   frame.locator('#su-con').fill('No new dependencies');frame.locator('#su-con').press('Enter')
  page.screenshot(path=str(tmp/(name+'.png')))
 page.set_viewport_size({'width':1600,'height':400});page.goto((tmp/'banner.html').as_uri());page.screenshot(path=str(ext/'images/banner.png'))
 browser.close()
# Preserve existing public URLs while replacing every old explanatory asset.
static={'s1-slash-menu.png':'slash','s2-hub-tracking.png':'request','s3-hub-pivot.png':'pivot','s4-hub-briefing.png':'briefing','s5-session.png':'repaired','s6-welcome.png':'welcome','s7-command-center.png':'center','s9-setup.png':'setup','s10-palette.png':'palette','s12-consent.png':'consent','s13-tour.png':'tour','panel-anatomy.png':'anatomy'}
for dest,src in static.items():(out/dest).write_bytes((tmp/(src+'.png')).read_bytes())
for dest,names in {'hero.gif':['request','stopped','active','repaired','complete'],'gif-ask.gif':['welcome','request'],'gif-pivot.gif':['request','pivot'],'gif-review.gif':['review','corrected','learning']}.items():
 frames=[Image.open(tmp/(n+'.png')).convert('RGB') for n in names]
 frames[0].save(out/dest,save_all=True,append_images=frames[1:],duration=8000,loop=0,optimize=True)
print('Rebuilt banner, all store illustrations and GIFs from current source; retained the unchanged logo.')
