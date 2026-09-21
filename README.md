# Grove

Calliope mini MakeCode package for for Grove Seeed Studio modules.

## Basic usage

### Grove - Gesture

get gesture model.

```blocks


grove.onGesture(GroveGesture.Up, () => {
    basic.showString("Up");
})
grove.onGesture(GroveGesture.Down, () => {
    basic.showString("Down");
})


grove.initGesture()
basic.forever(function () {
    if (grove.getGestureModel() == 1) {
        basic.showLeds(`
            . . # . .
            . . . # .
            # # # # #
            . . . # .
            . . # . .
            `)
    }
    if (grove.getGestureModel() == 2) {
        basic.showLeds(`
            . . # . .
            . # . . .
            # # # # #
            . # . . .
            . . # . .
            `)
    }
    if (grove.getGestureModel() == 3) {
        basic.showLeds(`
            . . # . .
            . # # # .
            # . # . #
            . . # . .
            . . # . .
            `)
    }
    if (grove.getGestureModel() == 4) {
        basic.showLeds(`
            . . # . .
            . . # . .
            # . # . #
            . # # # .
            . . # . .
            `)
    }
    basic.pause(100)
})
```
all the model
```

/**
 * Grove Gestures
 */
enum GroveGesture {
    //% block=None
    None = 0,
    //% block=Right
    Right = 1,
    //% block=Left
    Left = 2,
    //% block=Up
    Up = 3,
    //% block=Down
    Down = 4,
    //% block=Forward
    Forward = 5,
    //% block=Backward
    Backward = 6,
    //% block=Clockwise
    Clockwise = 7,
    //% block=Anticlockwise
    Anticlockwise = 8,
    //% block=Wave
    Wave = 9
}
```

### Grove - Ultrasonic Ranger

Measure distance in centimeters, specify the signal pin.

```blocks
let distance = grove.measureInCentimeters(DigitalPin.P0);
```

Measure distance in inches, specify the signal pin.

```blocks
let distance = grove.measureInInches(DigitalPin.P0);
```

### Grove - Moisture sensor

Select type of moisture sensor, Seeed Grove (blue), or Calliope mini (black) depending on the sensor type you are using.

Measures the soil moisture as absolute values from 0 - 1023

Measures the soil moisture as a percentage from 0 - 100

```blocks
let moisture = grove.measureMoisturePercent(AnalogPin.C16);
```

### Grove - 4 digital display

Create a 4 Digital Display driver, specify the clk and data pin, and set the brightness level, then start display value.

```blocks
let display = grove.createDisplay(DigitalPin.P0, DigitalPin.P1);
display.set(7);
display.show(1234);
```

Use ``||bit||`` to display one bit number.

Use ``||point||`` to open or close point dispay.

Use ``||clear||`` to clean display.

### Grove - UART WiFi V2

Connect to a WiFi and send data to ThinkSpeak or IFTTT, specify the UART tx and rx pin.

```blocks
grove.setupWifi(
    SerialPin.P15,
    SerialPin.P1,
    BaudRate.BaudRate115200,
    "test-ssid",
    "test-passwd"
)

basic.forever(() => {
    if (grove.wifiOK()) {
        basic.showIcon(IconNames.Yes)
    } else {
        basic.showIcon(IconNames.No)
    }
    grove.sendToThinkSpeak("write_api_key", 1, 2, 3, 4, 5, 6, 7, 8)
    grove.sendToIFTTT("ifttt_event", "ifttt_key", "hello", 'micro', 'bit')
    basic.pause(60000)
})
```

### IoT — Calliope Campus dashboards

Blocks in the `iot` namespace send measurements to a Campus IoT dashboard and
receive values back. German block text, German API names — the extension is
written for German classrooms.

Two transports, one line protocol:

* **Campus** (default) — `serial.writeLine`-style lines over the USB/BLE link to
  the open Campus tab. No token in the program, no WLAN module, no
  `serial.redirect`; the Campus tab knows both the token and the device.
* **WLAN** — the Grove UART WiFi module, `POST /api/iot/v1/ingest` over AT. Needs
  a write token in the program. Reuses `grove.setupWifi` and the package's AT
  helpers.

In the simulator the Campus transport works unchanged — MakeCode posts simulated
serial output to the host page. The `+` on the transport block turns that on; it
is off by default.

```blocks
iot.uebertragung(IotWeg.Campus)
iot.verbindeDashboard("klassen-garten")

basic.forever(function () {
    iot.sende("temperatur", input.temperature())
    basic.pause(5000)
})

iot.beiWert("pumpe", function (wert, von, an) {
    basic.showNumber(wert)
})
```

| Block | What it does |
| --- | --- |
| `iot.uebertragung(art, sim?)` | Chooses the transport: `IotWeg.Campus` or `IotWeg.WLAN`. Without it, Campus applies. The `sim` switch behind the `+` allows sending from the simulator (default off). |
| `iot.verbindeDashboard(token, server?)` | Token (`R-…`, `W-…`, `R-…:W-…`) or dashboard slug. May stay empty on the Campus transport. |
| `iot.sende(feed, wert, ziel?)` | Queues a number. |
| `iot.sendeText(feed, wert, ziel?)` | Queues a text. Separate block because pxt has no union types. |
| `iot.sendeJetzt()` | Flushes the queue now instead of waiting for the 5 s tick. |
| `iot.beiWert(feed, handler)` | Runs when a number arrives; `wert`, `von`, `an` are draggable reporters. |
| `iot.beiText(feed, handler)` | The same for text. |
| `iot.lese(feed, von?, an?)` | Last known number. Reads the RAM cache, never the network — safe inside a loop. |
| `iot.leseText(feed, von?, an?)` | Last known text. |
| `iot.protokolliere(text)` | A log line for the Campus monitor (Campus transport only). |
| `iot.status()` | `IotStatus.Getrennt` / `Verbunden` / `Sendet` / `Fehler`. |
| `iot.meineGeraeteId()` | The device's five-letter name, the same one the Campus connection bar shows. |
| `iot.zeitBekannt()` | False until the server has sent the time. |
| `iot.uhrzeit()` `iot.stunde()` `iot.minute()` `iot.sekunde()` `iot.datum()` `iot.zeitstempel()` | Clock, learned from the server response. `--:--` while unknown, so a clock program never shows 1970. |

**Addressing.** `ziel`, `von` and `an` are strings: empty means everyone, `"0"`
means the dashboard, anything else is a device name. The hidden `iot_ziel`
dropdown sits in those fields so children pick the words "alle" and "Dashboard"
instead of the codes. There is no `-1`.

**Behind the blocks.** `sende` never transmits immediately: it appends to a
24-entry ring buffer (oldest dropped on overflow) that a `control.inBackground`
fiber flushes every 5 seconds. A failed WLAN request backs off 1 s, 2 s, 4 s …
up to 30 s, and a `retry_after` from the server always wins.

## License

MIT

## Supported targets

* for PXT/calliopemini
