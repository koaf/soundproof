"""HTTP E2E: real ES module worker + WASM (not a shim). Requires playwright/chromium."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import subprocess, time, shutil, wave, struct, tempfile
root=Path(__file__).resolve().parent.parent
port=18763
with subprocess.Popen(['python','-m','http.server',str(port),'--bind','127.0.0.1'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL) as server:
 try:
  time.sleep(.5)
  with sync_playwright() as p:
   browser=p.chromium.launch(headless=True,executable_path=shutil.which('chromium'),args=['--no-sandbox','--disable-dev-shm-usage','--autoplay-policy=no-user-gesture-required'])
   page=browser.new_page(accept_downloads=True,viewport={'width':1280,'height':960})
   errors=[]
   page.on('pageerror',lambda e: errors.append(str(e)))
   page.goto(f'http://127.0.0.1:{port}/',wait_until='networkidle')
   assert page.locator('.tiny-label').inner_text()=='v0.3'
   page.locator('#fileInput').set_input_files(str(root/'tests/samples/hum.wav'))
   page.wait_for_function('document.querySelector("#batchProgress").textContent.includes("1 / 1")',timeout=90000)
   assert 'ハム候補' in page.locator('#noiseCandidateList').inner_text()
   first=page.locator('.noise-candidate').first
   first.click()
   assert not page.locator('#listenOriginal').is_disabled()
   assert not page.locator('#listenRepaired').is_disabled()
   start=page.locator('#selectionTimes').inner_text()
   print('selected region:',start)
   page.locator('#listenOriginal').click()
   page.wait_for_timeout(400)
   page.locator('#listenRepaired').click()
   page.wait_for_timeout(450)
   page.locator('#applyRepair').click()
   page.wait_for_function('document.querySelector("#repairStatus").textContent.includes("適用しました")',timeout=90000)
   assert not page.locator('#undoRepair').is_disabled()
   print('after apply:',page.locator('#repairStatus').inner_text())
   with page.expect_download(timeout=30000) as d:
    page.locator('#tabDetailed').click()
    page.locator('#exportWavButton').click()
   item=d.value
   with tempfile.TemporaryDirectory() as td:
    output=Path(td)/item.suggested_filename
    item.save_as(str(output))
    with wave.open(str(output),'rb') as wav:
     assert wav.getnchannels()==1
     print('exported WAV:',wav.getframerate(),wav.getnframes(),'frames')
   page.locator('#tabSimple').click()
   page.locator('#undoRepair').click()
   assert page.locator('#undoRepair').is_disabled()
   print('undo:',page.locator('#repairStatus').inner_text())
   # Test drag selecting a non-candidate segment.
   wave=page.locator('.waveform-wrap')
   bbox=wave.bounding_box()
   page.mouse.move(bbox['x']+bbox['width']*.31,bbox['y']+bbox['height']*.45)
   page.mouse.down()
   page.mouse.move(bbox['x']+bbox['width']*.38,bbox['y']+bbox['height']*.45,steps=6)
   page.mouse.up()
   assert not page.locator('#applyRepair').is_disabled()
   assert page.locator('#repairMethod').input_value()=='5'
   print('drag selected:',page.locator('#selectionTimes').inner_text())
   page.screenshot(path=str(root/'tests/soundproof-v03-desktop.png'),full_page=True)
   page.set_viewport_size({'width':390,'height':844})
   page.screenshot(path=str(root/'tests/soundproof-v03-mobile.png'),full_page=True)
   print('browser errors:',errors)
   assert not errors
   browser.close()
 finally:
  server.terminate()
