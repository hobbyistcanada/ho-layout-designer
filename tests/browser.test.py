# Browser smoke test: python3 tests/browser.test.py  (needs playwright + chrome)
# Serves the app, opens the sample gallery, loads every sample in 2D and 3D and fails on JS errors.
import http.server, threading, functools, sys, os
from playwright.sync_api import sync_playwright
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ho-shots'
os.makedirs(out, exist_ok=True)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(http.server.SimpleHTTPRequestHandler, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    pg = b.new_page(viewport={'width': 1500, 'height': 900})
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    pg.goto('http://127.0.0.1:8765/index.html'); pg.wait_for_timeout(800)
    pg.click('#bDemo'); pg.wait_for_timeout(500)
    pg.screenshot(path=f'{out}/gallery.png')
    n = pg.locator('.sampleCard').count()
    print('cards', n)
    for i in range(n):
        if i: pg.click('#bDemo'); pg.wait_for_timeout(300)
        name = pg.locator('.sampleCard .sTitle').nth(i).inner_text().split('\n')[0]
        pg.locator('.sampleCard').nth(i).click(); pg.wait_for_timeout(600)
        pg.click('#viewSeg [data-view="2d"]'); pg.wait_for_timeout(300)
        pg.click('#tFit'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'{out}/s{i}-2d.png')
        print(name, '| issues:', pg.locator('#issueCount').inner_text(), '|', pg.locator('#issues').inner_text()[:200].replace('\n', ' / '))
        pg.click('#viewSeg [data-view="3d"]'); pg.wait_for_timeout(4000)
        pg.screenshot(path=f'{out}/s{i}-3d.png')
        if pg.locator('#no3d:not(.hidden)').count(): print('  3D unavailable (three.js CDN not reachable)')
        else:
            pg.click('#b3Train'); pg.wait_for_timeout(2500)
            pg.screenshot(path=f'{out}/s{i}-3d-train.png'); pg.click('#b3Train')
    # bridge snapping: load the figure 8, drop a girder bridge near a raised track, expect it aligned at track height
    pg.click('#viewSeg [data-view="2d"]'); pg.click('#bDemo'); pg.wait_for_timeout(300)
    pg.locator('.sampleCard').nth(1).click(); pg.wait_for_timeout(500)
    pt = pg.evaluate('''() => { const {state, ed} = window.hoApp; const pc = state.project.pieces.find(p => p.z > 2 && p.kind === 'straight');
      const r = document.querySelector('#plan').getBoundingClientRect(); const a = pc.rot * Math.PI / 180;
      const wx = pc.x + Math.cos(a) * 5 + 1, wy = pc.y + Math.sin(a) * 5;   // 1" off the centreline
      return { x: r.left + wx * ed.s + ed.tx, y: r.top + ed.ty - wy * ed.s, z: pc.z + pc.grade / 100 * 5, rot: pc.rot }; }''')
    pg.click('#leftTabs [data-tab="scenery"]'); pg.click('[data-place="scenery:girder"]')
    pg.mouse.click(pt['x'], pt['y']); pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
    o = pg.evaluate('() => { const s = window.hoApp.state.project.scenery; return s[s.length - 1]; }')
    ok = o['type'] == 'girder' and abs(o['base'] - pt['z']) < 0.15 and abs(((o['rot'] - pt['rot']) % 180 + 180) % 180) < 1
    print('bridge snap:', 'OK' if ok else 'FAIL', {k: o[k] for k in ('type', 'base', 'rot')}, 'track z %.2f rot %.1f' % (pt['z'], pt['rot']))
    if not ok: errors.append('bridge did not snap to track')
    pg.screenshot(path=f'{out}/bridge-snap.png')
    b.close()
srv.shutdown()
# 3D needs three.js from the CDN; when offline those load failures are expected, not app bugs
offline = ('ERR_TUNNEL', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED', 'view3d.js', 'favicon', 'status of 404')
errors = [e for e in errors if not any(k in e for k in offline)]
print('JS errors:', errors if errors else 'none')
sys.exit(1 if errors else 0)
