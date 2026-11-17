// Android uygulamasına özel köprü: arka planda konum ve yerel Bluetooth nabız.
// esbuild ile www/native.js olarak paketlenir; web sürümünde yüklenmez.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
const HR_MEASUREMENT = '00002a37-0000-1000-8000-00805f9b34fb';
let bleReady = false;

window.izimNative = {
  isNative: Capacitor.isNativePlatform(),

  // Ekran kapalıyken de konum: bildirim çubuğunda kalıcı bildirimle çalışan ön plan servisi
  async startTracking(onLocation, onError) {
    return BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'İzim kaydediyor',
        backgroundMessage: 'Yürüyüşün kaydediliyor. Bitirmek için uygulamayı aç.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
      (loc, err) => {
        if (err) { if (onError) onError(err); return; }
        if (loc) onLocation(loc);
      },
    );
  },
  stopTracking(id) {
    return BackgroundGeolocation.removeWatcher({ id });
  },
  openSettings() {
    return BackgroundGeolocation.openSettings();
  },

  // Standart Bluetooth nabız servisi (Polar H10/H9/Verity Sense vb.)
  async hrConnect(onValue, onDisconnect) {
    if (!bleReady) { await BleClient.initialize(); bleReady = true; }
    const dev = await BleClient.requestDevice({ services: [HR_SERVICE] });
    await this.hrAttach(dev.deviceId, onValue, onDisconnect);
    return { id: dev.deviceId, name: dev.name || 'Nabız cihazı' };
  },
  async hrAttach(id, onValue, onDisconnect) {
    await BleClient.connect(id, () => { if (onDisconnect) onDisconnect(); });
    await BleClient.startNotifications(id, HR_SERVICE, HR_MEASUREMENT, (value) => onValue(value));
  },
  async hrDisconnect(id) {
    try { await BleClient.stopNotifications(id, HR_SERVICE, HR_MEASUREMENT); } catch (e) { /* zaten kopuk */ }
    try { await BleClient.disconnect(id); } catch (e) { /* zaten kopuk */ }
  },
};
