/**
 * IoT — Daten zwischen einem Calliope mini und einem Campus-Dashboard.
 *
 * Zwei Wege, ein Protokoll (siehe calliope-campus/src/lib/services/iot/wire.ts):
 *
 *   Campus (Vorgabe)  serielle Leitung zum Verbindungs-Widget im Campus-Tab.
 *                     Der Campus kennt Token und Seriennummer, das Programm
 *                     braucht beides nicht. `serial.redirect` wird hier NIE
 *                     aufgerufen — die USB-Leitung ist das Rohr.
 *   WLAN              Grove UART-WiFi-Modul, HTTP POST auf /api/iot/v1/ingest.
 *                     Braucht einen Schreibtoken im Programm.
 *
 * Gesendet wird nie sofort: `sende` legt in einen Ringpuffer, ein
 * Hintergrund-Fiber leert ihn im Takt. Sonst hält ein AT-Kommando die
 * `dauerhaft`-Schleife an, und das erste, was Kinder programmieren, ist eine
 * Schleife.
 *
 * Zeilenformat Gerät → Campus
 *   IOT1:d:<ziel>:<feed>:<wert>
 *   IOT1:l:<text>
 *   IOT1:h:<referenz>
 * Zeilenformat Campus → Gerät
 *   IOT1:v:<von>:<an>:<feed>:<wert>
 *   IOT1:t:<unixsekunden>:<zeitzone in minuten>
 *   IOT1:e:<code>
 */

/**
 * Über welchen Weg die Daten das Gerät verlassen.
 */
enum IotWeg {
    //% block="Campus"
    Campus = 0,
    //% block="WLAN"
    WLAN = 1
}

/**
 * Zustand der IoT-Verbindung.
 */
enum IotStatus {
    //% block="getrennt"
    Getrennt = 0,
    //% block="verbunden"
    Verbunden = 1,
    //% block="sendet"
    Sendet = 2,
    //% block="Fehler"
    Fehler = 3
}

/**
 * Wer gemeint ist. Kinder sehen Wörter, das Protokoll sieht Zeichenketten:
 * "alle" ist der leere Text, "Dashboard" ist "0", alles andere ist eine
 * Seriennummer. Ein `-1` gibt es bewusst nicht — leer heißt schon „an alle".
 */
enum IotZiel {
    //% block="alle"
    Alle = 0,
    //% block="Dashboard"
    Dashboard = 1
}

/**
 * Wie oft gesammelte Werte losgeschickt werden.
 *
 * Gesammelt wird immer — `sende` legt in einen Ringpuffer, und was hier steht,
 * ist nur der Takt, in dem er geleert wird. „Sofort" heißt: jeder Wert geht
 * einzeln raus, sobald er entsteht.
 */
enum IotTakt {
    //% block="sofort"
    Sofort = 0,
    //% block="jede Sekunde"
    Sekunde = 1000,
    //% block="alle 5 Sekunden"
    FuenfSekunden = 5000,
    //% block="jede Minute"
    Minute = 60000,
    //% block="jede Stunde"
    Stunde = 3600000
}

/**
 * Daten an ein Campus-Dashboard senden und von dort empfangen.
 */
//% weight=9 color=#0E7C86 icon="\uf0c2" block="IoT"
//% groups='["Verbindung","Senden","Empfangen","Uhrzeit","Diagnose"]'
namespace iot {

    // ── Protokoll ────────────────────────────────────────────────────────────

    const WIRE = "IOT1:"

    // Ringpuffer. 24 Punkte sind gut 700 B — genug für einen Ausfall von zwei
    // Minuten bei 5 s Takt, wenig genug neben einem Schülerprogramm.
    const PUFFER_MAX = 24
    // So viele Punkte trägt ein WLAN-Request. Die Antwort muss durch den
    // Serial-RX-Puffer des minis passen (254 B), also klein halten.
    const BATCH_MAX = 8
    const CACHE_MAX = 16
    const EMPFANG_MAX = 8

    // Vorgabe-Sendetakt. Veränderbar über den Dashboard-Block; `taktMs` ist der
    // Wert, der wirklich gilt.
    const TAKT_MS = 5000
    let taktMs = TAKT_MS
    const BACKOFF_START_MS = 1000
    const BACKOFF_MAX_MS = 30000

    /**
     * Wie oft der Puffer geleert wird.
     *
     * „Sofort" schickt jeden Wert einzeln, sobald er entsteht — über den Campus
     * ist das billig, die serielle Leitung steht ohnehin offen. Über WLAN ist es
     * das Gegenteil von billig: Jeder Punkt wäre ein eigener HTTP-Request, und
     * der Server nimmt pro Gerät nur etwa einen pro Sekunde an. Darum wird
     * „Sofort" auf dem WLAN-Weg auf eine Sekunde angehoben, statt in Fehler zu
     * laufen.
     *
     * Für den Stromverbrauch bringt ein langsamerer Takt weniger, als man
     * denkt: Das WLAN-Modul kostet im Leerlauf grob 70–100 mA, gesendet wird
     * nur in kurzen Spitzen. Gespart wird hier Funkverkehr und Serverlast, kein
     * nennenswerter Strom — dafür müsste das Modul schlafen, und dann empfängt
     * es auch nichts mehr.
     */
    const TAKT_SOFORT_WLAN_MS = 1000

    // ── Zustand ──────────────────────────────────────────────────────────────

    let weg = IotWeg.Campus
    let simSenden = false
    let simGeprueft = false
    let simErkannt = false

    let referenz = ""
    let serverAdresse = "campus-api.calliope.cc"
    let geraeteId = ""

    let gestartet = false
    let hoertZu = false
    let zustand = IotStatus.Getrennt

    let naechsterFlushMs = 0
    // Zeitpunkt der letzten Sendung — der Boden zwischen zwei Sendungen.
    let letzterSendeMs = 0
    let naechsterVersuchMs = 0
    let backoffMs = 0
    let sofort = false

    // Sendepuffer (parallele Felder statt Objekten: kein Allozieren je Punkt)
    let pFeed: string[] = []
    let pWert: string[] = []
    let pZiel: string[] = []
    let pZeit: number[] = []

    // Zuletzt bekannter Wert je Feed. `lese` liest hier, nie im Netz.
    let cFeed: string[] = []
    let cText: string[] = []
    let cZahl: number[] = []
    let cIstZahl: boolean[] = []
    let cVon: string[] = []
    let cAn: string[] = []

    // Empfangene Werte warten hier auf den Hintergrund-Fiber. Direkt aus dem
    // Serial-Fiber heraus aufzurufen wäre bequemer, aber ein `zeige Zahl` im
    // Handler hielte dann die Leitung an und der nächste Downlink ginge verloren.
    let eFeed: string[] = []
    let eWert: string[] = []
    let eVon: string[] = []
    let eAn: string[] = []

    let zFeeds: string[] = []
    let zHandler: ((wert: number, von: string, an: string) => void)[] = []
    let tFeeds: string[] = []
    let tHandler: ((text: string, von: string, an: string) => void)[] = []

    // Uhr
    let uhrOffsetMs = 0
    let uhrZoneMin = 0
    let uhrGesetzt = false

    // ── Der eine Übergabepunkt ───────────────────────────────────────────────

    /**
     * Die einzige Stelle, an der eine Zeile das Gerät in Richtung Campus
     * verlässt — Datenpunkt, Logzeile und Hallo laufen alle hier durch.
     *
     * Im Simulator kommt davon heute NICHTS beim Campus an, und das ist
     * nachgesehen, nicht vermutet: Der MakeCode-Editor reicht an einen Host nur
     * `simevent` weiter (pxt/webapp/src/simulator.ts), serielle Ausgaben des
     * Simulators bleiben im Editor. Der Schalter hinter dem „+" am
     * Übertragungsblock bleibt trotzdem — er ist der Anknüpfpunkt, sobald die
     * Editor-Seite die Zeilen weiterreicht. Entwicklungsweg bis dahin: das
     * echte Gerät am USB-Kabel.
     *
     * Kein `serial.writeLine`: das füllt die Zeile vor dem Zeilenende mit
     * Leerzeichen auf 32 Byte auf, und der Wert steht im Protokoll am Ende der
     * Zeile — die Füllzeichen wären Teil des Wertes.
     */
    function emit(zeile: string): void {
        if (istSimulator() && !simSenden) return
        serial.writeString(zeile)
        serial.writeString("\r\n")
    }

    /**
     * Der Simulator meldet sich als Hardware-Version "0.0", ein echtes Gerät
     * mit "1.X", "2" oder "3".
     */
    function istSimulator(): boolean {
        if (!simGeprueft) {
            simGeprueft = true
            simErkannt = control._hardwareVersion() == "0.0"
        }
        return simErkannt
    }

    // ── Blöcke: Verbindung ───────────────────────────────────────────────────

    /**
     * Legt fest, worüber die Daten laufen. Ohne diesen Block gilt „Campus".
     * @param art Campus (USB/BLE über den geöffneten Campus-Tab) oder WLAN
     * @param sim auch im Simulator senden — Testwerkzeug, Vorgabe aus
     */
    //% blockId=iot_uebertragung
    //% block="übertrage per $art || im Simulator senden $sim"
    //% expandableArgumentMode="toggle"
    //% sim.defl=false
    //% group="Verbindung"
    //% weight=110 blockGap=8
    export function uebertragung(art: IotWeg, sim: boolean = false): void {
        weg = art
        simSenden = sim
        starte()
        hoerZu()
        if (weg == IotWeg.Campus) sendeHallo()
    }

    // Hinweis zu allen Blöcken hier: Textparameter haben KEINEN Vorgabewert im
    // TypeScript (`server: string = "…"`). pxt lässt als Initialisierer nur
    // Zahlen, null, true und false zu (pxtcompiler/emitter/emitter.ts:2252) und
    // bricht sonst mit „only numbers, null, true and false supported as default
    // arguments" ab — der Fehler erscheint, sobald man den Block ablegt. Was im
    // Block vorbelegt ist, sagt `//% …defl=`; im Code ist der Parameter
    // schlicht optional und die Funktion fängt den Leerfall ab.

    /**
     * Sagt, zu welchem Dashboard die Daten gehören. Über den Weg „Campus"
     * darf das Feld leer bleiben — dann nimmt der Campus den Token aus dem
     * geöffneten Programm.
     * @param token Token (R-… / W-… / R-…:W-…) oder Kurzname des Dashboards
     * @param server Adresse des Campus-Servers
     */
    //% blockId=iot_verbinde_dashboard
    //% block="Dashboard $token || Server $server senden $takt"
    //% expandableArgumentMode="toggle"
    //% token.defl=""
    //% server.defl="campus-api.calliope.cc"
    //% takt.defl=IotTakt.FuenfSekunden
    //% group="Verbindung"
    //% weight=100 blockGap=8
    export function verbindeDashboard(token: string, server?: string, takt?: IotTakt): void {
        referenz = token ? token.trim() : ""
        if (server && server.trim() != "") serverAdresse = server.trim()
        setzeTakt(takt)
        starte()
        if (weg == IotWeg.Campus) sendeHallo()
    }

    /**
     * Übernimmt den gewählten Takt. `undefined` heißt „nicht angegeben" — dann
     * bleibt es beim bisherigen Wert, sonst würde ein zugeklapptes „+" die
     * Einstellung eines zweiten Blocks stillschweigend zurücksetzen.
     */
    function setzeTakt(takt?: IotTakt): void {
        if (takt == undefined) return
        if (takt == IotTakt.Sofort) {
            // Über WLAN ist „sofort" ein Versprechen, das der Server nicht
            // einlöst: Er nimmt pro Gerät etwa einen Batch je Sekunde an. Also
            // hier begrenzen, statt das Kind gegen 429er laufen zu lassen.
            taktMs = weg == IotWeg.WLAN ? TAKT_SOFORT_WLAN_MS : 0
        } else {
            taktMs = takt as number
        }
        naechsterFlushMs = control.millis() + taktMs
    }

    function sendeHallo(): void {
        // Nichts sagen, solange nichts zu sagen ist. `uebertragung` läuft im
        // Blockstapel VOR `verbindeDashboard`; meldete es sich schon hier an,
        // bekäme der Campus zuerst eine leere Referenz samt Vorgabeserver und
        // müsste sich Sekundenbruchteile später korrigieren lassen — in der
        // Zwischenzeit weiß er nicht, wohin mit den Daten.
        if (referenz == "") return
        // Zwei Zeilen, weil die Referenz einen Doppelpunkt tragen darf
        // ("R-…:W-…") und darum am Zeilenende stehen muss. Die Serveradresse
        // sagt dem Campus, wohin er schreiben soll: Steht im Programm ein Token
        // samt Adresse, schickt er den Punkt wörtlich dorthin, statt selbst zu
        // entscheiden — was im Block steht, passiert auch.
        emit(WIRE + "s:" + serverAdresse)
        emit(WIRE + "h:" + referenz)
    }

    // ── Blöcke: Senden ───────────────────────────────────────────────────────

    /**
     * Legt eine Zahl in den Sendepuffer. Verschickt wird im Takt, nicht sofort.
     * @param feed Name der Messreihe, z.B. "temperatur"
     * @param wert Zahl
     * @param ziel wer den Wert bekommen soll
     */
    //% blockId=iot_sende
    //% block="sende $feed = $wert || an $ziel"
    //% expandableArgumentMode="toggle"
    //% feed.defl="temperatur"
    //% ziel.shadow="iot_ziel"
    //% group="Senden"
    //% weight=90 blockGap=8
    export function sende(feed: string, wert: number, ziel?: string): void {
        lege(feed, zahlText(wert), ziel ? ziel : "")
    }

    /**
     * Legt einen Text in den Sendepuffer.
     * @param feed Name der Messreihe, z.B. "zustand"
     * @param wert Text
     * @param ziel wer den Text bekommen soll
     */
    //% blockId=iot_sende_text
    //% block="sende Text $feed = $wert || an $ziel"
    //% expandableArgumentMode="toggle"
    //% feed.defl="zustand"
    //% wert.defl="hallo"
    //% ziel.shadow="iot_ziel"
    //% group="Senden"
    //% weight=89 blockGap=8
    export function sendeText(feed: string, wert: string, ziel?: string): void {
        lege(feed, einzeilig(wert), ziel ? ziel : "")
    }

    /**
     * Schickt den Sendepuffer sofort los, ohne auf den Takt zu warten.
     */
    //% blockId=iot_sende_jetzt
    //% block="sende jetzt"
    //% group="Senden"
    //% weight=85 blockGap=8
    export function sendeJetzt(): void {
        starte()
        sofort = true
    }

    /**
     * Schreibt eine Zeile ins Campus-Protokoll. Über den Weg „WLAN" gehört die
     * serielle Leitung dem Funkmodul, dort passiert bis auf Weiteres nichts —
     * der Rückkanal dafür ist die RAM-Ablage (Stufe F des Plans).
     * @param text Text fürs Protokoll
     */
    //% blockId=iot_protokolliere
    //% block="protokolliere $text"
    //% text.defl="hallo"
    //% group="Diagnose"
    //% weight=40 blockGap=8
    export function protokolliere(text: string): void {
        if (weg != IotWeg.Campus) return
        emit(WIRE + "l:" + einzeilig(text))
    }

    function lege(feed: string, wert: string, ziel: string): void {
        const schluessel = feldText(feed)
        if (schluessel == "") return
        starte()
        if (pFeed.length >= PUFFER_MAX) {
            // Bei Überlauf fliegt der älteste: der Trend bleibt erhalten,
            // der aktuelle Wert erst recht.
            pFeed.shift()
            pWert.shift()
            pZiel.shift()
            pZeit.shift()
        }
        pFeed.push(schluessel)
        pWert.push(wert)
        pZiel.push(feldText(ziel))
        pZeit.push(control.millis())
        // Takt "sofort": nicht auf den nächsten Zeitpunkt warten, sondern beim
        // nächsten Schleifendurchlauf raus.
        if (taktMs == 0) sofort = true
        // Voller Puffer schickt ebenfalls los, unabhängig vom Takt. Der Takt ist
        // ein Versprechen über die Verzögerung, der Puffer eine Grenze für den
        // Speicher; treffen sie aufeinander, ist ein zu früh gesendeter Wert
        // besser als ein weggeworfener — eine Lücke im Diagramm sieht aus wie
        // ein kaputter Sensor. Den Mindestabstand hebt das NICHT auf (siehe
        // Schleife): „voll" erhöht die Dringlichkeit, es entfernt keinen Boden.
        if (pFeed.length >= PUFFER_MAX) sofort = true
    }

    // ── Blöcke: Empfangen ────────────────────────────────────────────────────

    /**
     * Läuft, wenn für diese Messreihe eine Zahl eintrifft.
     * @param feed Name der Messreihe, z.B. "pumpe"
     */
    //% blockId=iot_bei_wert
    //% block="wenn $feed empfangen"
    //% draggableParameters="reporter"
    //% feed.defl="temperatur"
    //% group="Empfangen"
    //% weight=80 blockGap=8
    export function beiWert(feed: string, handler: (wert: number, von: string, an: string) => void): void {
        starte()
        zFeeds.push(feldText(feed))
        zHandler.push(handler)
    }

    /**
     * Läuft, wenn für diese Messreihe ein Text eintrifft.
     * @param feed Name der Messreihe, z.B. "nachricht"
     */
    //% blockId=iot_bei_text
    //% block="wenn Text $feed empfangen"
    //% draggableParameters="reporter"
    //% feed.defl="nachricht"
    //% group="Empfangen"
    //% weight=79 blockGap=8
    export function beiText(feed: string, handler: (text: string, von: string, an: string) => void): void {
        starte()
        tFeeds.push(feldText(feed))
        tHandler.push(handler)
    }

    /**
     * Der zuletzt empfangene Zahlenwert. Liest den Zwischenspeicher, nicht das
     * Netz — der Block hält eine Schleife nie an.
     * @param feed Name der Messreihe
     * @param von nur Werte von diesem Absender
     * @param an nur Werte an diesen Empfänger
     */
    //% blockId=iot_lese_zahl
    //% block="lese $feed || von $von an $an"
    //% expandableArgumentMode="toggle"
    //% feed.defl="temperatur"
    //% von.shadow="iot_ziel"
    //% an.shadow="iot_ziel"
    //% group="Empfangen"
    //% weight=70 blockGap=8
    export function lese(feed: string, von?: string, an?: string): number {
        const i = suche(feldText(feed), feldText(von), feldText(an))
        if (i < 0) return 0
        return cIstZahl[i] ? cZahl[i] : 0
    }

    /**
     * Der zuletzt empfangene Text.
     * @param feed Name der Messreihe
     * @param von nur Werte von diesem Absender
     * @param an nur Werte an diesen Empfänger
     */
    //% blockId=iot_lese_text
    //% block="lese Text $feed || von $von an $an"
    //% expandableArgumentMode="toggle"
    //% feed.defl="nachricht"
    //% von.shadow="iot_ziel"
    //% an.shadow="iot_ziel"
    //% group="Empfangen"
    //% weight=69 blockGap=8
    export function leseText(feed: string, von?: string, an?: string): string {
        const i = suche(feldText(feed), feldText(von), feldText(an))
        if (i < 0) return ""
        return cText[i]
    }

    // ── Blöcke: Diagnose ─────────────────────────────────────────────────────

    /**
     * Zustand der Verbindung.
     */
    //% blockId=iot_status
    //% block="IoT-Status"
    //% group="Diagnose"
    //% weight=36 blockGap=8
    export function status(): IotStatus {
        return zustand
    }

    /**
     * Ein Status zum Vergleichen. Ohne diesen Baustein gäbe es kein Blockstück,
     * das man rechts neben „IoT-Status =" stecken könnte.
     */
    //% blockId=iot_status_wert
    //% block="$s"
    //% shim=TD_ID
    //% group="Diagnose"
    //% weight=35 blockGap=8
    export function statusWert(s: IotStatus): IotStatus {
        return s
    }

    /**
     * Die Kennung, unter der dieses Gerät im Dashboard auftaucht. Über den Weg
     * „Campus" trägt der Campus die Seriennummer der Verbindung ein; dieser
     * Wert ist dann nur Anzeige.
     */
    //% blockId=iot_geraete_id
    //% block="meine Geräte-ID"
    //% group="Diagnose"
    //% weight=30 blockGap=8
    export function meineGeraeteId(): string {
        if (geraeteId == "") {
            // Der Name kommt aus der Firmware selbst: `control.deviceName()` ist
            // `microbit_friendly_name()`, also genau der Name, den auch die
            // Verbindungsleiste im Campus zeigt. Nachbauen müsste man ihn nur,
            // wenn die Firmware etwas anderes liefert — dann greift der Rückfall.
            let name = control.deviceName()
            if (!istCvcvc(name)) name = freundlicherName(control.deviceSerialNumber())
            geraeteId = istSimulator() ? "sim-" + name : name
        }
        return geraeteId
    }

    const KONSONANTEN = "zvgpt"
    const VOKALE = "uoiea"

    /**
     * Derselbe Fünferkaskade wie `microbit_friendly_name()` in codal und DAL
     * (`MicroBitDevice.cpp`) und wie `friendlyNameFromDeviceId` im
     * Verbindungs-Widget: fünf Ziffern zur Basis 5 über
     * `NRF_FICR->DEVICEID[1]`, Buchstaben von hinten nach vorn gesetzt,
     * abwechselnd Konsonant und Vokal.
     */
    function freundlicherName(id: number): string {
        const zeichen = ["", "", "", "", ""]
        // Die Seriennummer ist vorzeichenlos; ohne `>>> 0` kippt die
        // Modulorechnung bei gesetztem obersten Bit ins Negative.
        let n = id >>> 0
        let ld = 1
        let d = 5
        for (let i = 0; i < 5; i++) {
            const h = Math.floor((n % d) / ld)
            n -= h
            d *= 5
            ld *= 5
            zeichen[4 - i] = (i % 2 == 0 ? KONSONANTEN : VOKALE).charAt(h)
        }
        return zeichen.join("")
    }

    function istCvcvc(name: string): boolean {
        if (!name || name.length != 5) return false
        for (let i = 0; i < 5; i++) {
            if ((i % 2 == 0 ? KONSONANTEN : VOKALE).indexOf(name.charAt(i)) < 0) return false
        }
        return true
    }

    /**
     * Übersetzt die Auswahl „alle" / „Dashboard" in das, was im Protokoll steht.
     * Versteckt, weil der Baustein nur als Vorlage in den Ziel-Feldern sitzt.
     */
    //% blockId=iot_ziel
    //% block="$ziel"
    //% blockHidden=true
    //% weight=1
    export function zielCode(ziel: IotZiel): string {
        return ziel == IotZiel.Dashboard ? "0" : ""
    }

    // ── Blöcke: Uhrzeit ──────────────────────────────────────────────────────

    /**
     * Wahr, sobald der Server die Uhrzeit geschickt hat. Vorher zeigt ein
     * Uhrprogramm besser `--:--` als eine falsche Zahl.
     */
    //% blockId=iot_zeit_bekannt
    //% block="Zeit bekannt?"
    //% group="Uhrzeit"
    //% weight=28 blockGap=8
    export function zeitBekannt(): boolean {
        return uhrGesetzt
    }

    /**
     * Die Uhrzeit als Text, z.B. "14:37".
     */
    //% blockId=iot_uhrzeit
    //% block="Uhrzeit"
    //% group="Uhrzeit"
    //% weight=27 blockGap=8
    export function uhrzeit(): string {
        if (!uhrGesetzt) return "--:--"
        return zwei(stunde()) + ":" + zwei(minute())
    }

    /**
     * Die Stunde (0-23), oder 0 solange die Zeit unbekannt ist.
     */
    //% blockId=iot_stunde
    //% block="Stunde"
    //% group="Uhrzeit"
    //% weight=26
    export function stunde(): number {
        if (!uhrGesetzt) return 0
        return Math.floor(lokaleSekunden() / 3600) % 24
    }

    /**
     * Die Minute (0-59).
     */
    //% blockId=iot_minute
    //% block="Minute"
    //% group="Uhrzeit"
    //% weight=25
    export function minute(): number {
        if (!uhrGesetzt) return 0
        return Math.floor(lokaleSekunden() / 60) % 60
    }

    /**
     * Die Sekunde (0-59).
     */
    //% blockId=iot_sekunde
    //% block="Sekunde"
    //% group="Uhrzeit"
    //% weight=24 blockGap=8
    export function sekunde(): number {
        if (!uhrGesetzt) return 0
        return lokaleSekunden() % 60
    }

    /**
     * Das Datum als Text, z.B. "21.09.2026".
     */
    //% blockId=iot_datum
    //% block="Datum"
    //% group="Uhrzeit"
    //% weight=23 blockGap=8
    export function datum(): string {
        if (!uhrGesetzt) return "--.--.----"
        const tage = Math.floor(lokaleSekunden() / 86400)
        // Zivilkalender aus Tagen seit 1970 (Verfahren nach Howard Hinnant):
        // nur Ganzzahlrechnung, keine Tabelle, Schaltjahre inklusive.
        const z = tage + 719468
        const era = Math.floor(z / 146097)
        const doe = z - era * 146097
        const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
        const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
        const mp = Math.floor((5 * doy + 2) / 153)
        const tag = doy - Math.floor((153 * mp + 2) / 5) + 1
        const monat = mp < 10 ? mp + 3 : mp - 9
        const jahr = (monat <= 2 ? yoe + era * 400 + 1 : yoe + era * 400)
        return zwei(tag) + "." + zwei(monat) + "." + jahr
    }

    /**
     * Die Unix-Zeit in Sekunden (UTC), für eigene Rechnungen. 0 solange die
     * Zeit unbekannt ist.
     */
    //% blockId=iot_zeitstempel
    //% block="Zeitstempel"
    //% group="Uhrzeit"
    //% weight=22
    export function zeitstempel(): number {
        if (!uhrGesetzt) return 0
        return Math.floor((control.millis() + uhrOffsetMs) / 1000)
    }

    function lokaleSekunden(): number {
        return zeitstempel() + uhrZoneMin * 60
    }

    /**
     * Uhr stellen. Der erste Wert setzt sie, spätere ziehen nur nach — und ein
     * Sprung nur, wenn mehr als zwei Sekunden Abweichung da sind, sonst zappelt
     * eine Sekundenanzeige hin und her.
     */
    function setzeZeit(unixSek: number, tzoMin: number): void {
        const neu = unixSek * 1000 - control.millis()
        if (!uhrGesetzt || Math.abs(neu - uhrOffsetMs) > 2000) uhrOffsetMs = neu
        uhrZoneMin = tzoMin
        uhrGesetzt = true
    }

    // ── Motor ────────────────────────────────────────────────────────────────

    function starte(): void {
        if (gestartet) return
        gestartet = true

        // Der serielle Puffer fasst per Vorgabe 20 Byte
        // (CODAL_SERIAL_DEFAULT_BUFFER_SIZE). Unsere Zeilen sind länger:
        // "IOT1:t:1790016481:120" allein sind 21, und die Serveradresse
        // "IOT1:s:http://localhost:8090/api/iot/v1" gut 40. Was nicht
        // hineinpasst, geht verloren — in die eine Richtung als verstümmelte
        // Ausgabe, in die andere als Zeile, die nie ankommt. Das ist der
        // Unterschied zwischen „liest nichts" und „liest".
        serial.setRxBufferSize(128)
        serial.setTxBufferSize(128)
        naechsterFlushMs = control.millis() + taktMs
        hoerZu()
        control.inBackground(function () {
            while (true) {
                basic.pause(100)
                verteileEmpfang()
                const jetzt = control.millis()
                if (jetzt < naechsterVersuchMs) continue
                if (sofort || jetzt >= naechsterFlushMs) {
                    // Der Boden, den auch „sofort" und ein voller Puffer nicht
                    // unterschreiten. Über WLAN wäre ein dauerhaft voller Puffer
                    // sonst ein Dauerfeuer: Ein Request trägt 8 Punkte, der
                    // Puffer hält 24 — wer schneller misst als sendet, bliebe
                    // für immer voll, und aus „jede Stunde" würde unbemerkt „so
                    // schnell der Server annimmt", mitsamt 429ern.
                    const boden = weg == IotWeg.WLAN ? TAKT_SOFORT_WLAN_MS : 0
                    if (jetzt < letzterSendeMs + boden) continue
                    sofort = false
                    letzterSendeMs = jetzt
                    // Untergrenze am Ende statt bei der Einstellung: Die
                    // Blockreihenfolge ist nicht garantiert, der Weg kann nach
                    // dem Takt gesetzt worden sein.
                    naechsterFlushMs = jetzt + (weg == IotWeg.WLAN && taktMs < TAKT_SOFORT_WLAN_MS ? TAKT_SOFORT_WLAN_MS : taktMs)
                    flush()
                }
            }
        })
    }

    /**
     * Rückkanal der seriellen Leitung. Wird genau einmal registriert und nur,
     * wenn der Weg „Campus" gilt: über WLAN gehört die Leitung dem Modul, und
     * ein Leser hier stähle dem AT-Automaten seine Antworten.
     */
    function hoerZu(): void {
        if (hoertZu || weg != IotWeg.Campus) return
        hoertZu = true
        serial.onDataReceived(serial.delimiters(Delimiters.NewLine), function () {
            if (weg != IotWeg.Campus) return
            const zeile = serial.readUntil(serial.delimiters(Delimiters.NewLine))
            empfangeZeile(zeile)
        })
    }

    function empfangeZeile(zeile: string): void {
        if (!zeile || zeile.indexOf(WIRE) != 0) return
        const rumpf = zeile.substr(WIRE.length, zeile.length - WIRE.length)
        const art = rumpf.substr(0, 1)
        const rest = rumpf.substr(2, rumpf.length - 2)

        if (art == "t") {
            // <unixsekunden>:<zeitzone>
            const p = rest.indexOf(":")
            if (p < 0) return
            const sek = parseFloat(rest.substr(0, p))
            const tzo = parseFloat(rest.substr(p + 1, rest.length - p - 1))
            if (isNaN(sek)) return
            setzeZeit(sek, isNaN(tzo) ? 0 : tzo)
            setzeZustand(IotStatus.Verbunden)
            return
        }
        if (art == "?") {
            // Der Campus fragt, wer hier hängt. Das passiert, wenn er später
            // dazukommt als das Programm — dann ist unsere Startmeldung längst
            // verklungen. Ohne diese Antwort läuft ein geflashtes Gerät ins
            // Leere, solange niemand den Editor öffnet.
            sendeHallo()
            return
        }
        if (art == "e") {
            setzeZustand(IotStatus.Fehler)
            merkeFehler(0)
            return
        }
        if (art == "v") {
            // <von>:<an>:<feed>:<wert…>  — der Wert steht am Ende und darf
            // Doppelpunkte enthalten, darum von vorne durchzählen.
            const a = rest.indexOf(":")
            if (a < 0) return
            const b = rest.indexOf(":", a + 1)
            if (b < 0) return
            const c = rest.indexOf(":", b + 1)
            if (c < 0) return
            const von = rest.substr(0, a).trim()
            const an = rest.substr(a + 1, b - a - 1).trim()
            const feed = rest.substr(b + 1, c - b - 1).trim()
            const wert = rest.substr(c + 1, rest.length - c - 1)
            if (feed == "") return
            setzeZustand(IotStatus.Verbunden)
            nimmAn(feed, wert, von == "" ? "0" : von, an)
        }
    }

    function flush(): void {
        if (weg == IotWeg.WLAN) {
            flushWlan()
            return
        }
        if (pFeed.length == 0) return
        const vorher = zustand
        setzeZustand(IotStatus.Sendet)
        while (pFeed.length > 0) {
            const feed = pFeed.shift()
            const wert = pWert.shift()
            const ziel = pZiel.shift()
            pZeit.shift()
            emit(WIRE + "d:" + ziel + ":" + feed + ":" + wert)
        }
        // Über den Campus gibt es keine Quittung; „verbunden" sagt erst der
        // Rückkanal (IOT1:t / IOT1:v). Also zurück in den Zustand von vorher:
        // Senden beweist nicht, dass jemand zuhört — „getrennt" wäre nach einem
        // erfolgreichen Schreiben aber schlicht falsch, und ein Programm ohne
        // Sollwerte bekäme nie einen Rückkanal, der es korrigiert.
        setzeZustand(vorher)
    }

    function setzeZustand(neu: IotStatus): void {
        zustand = neu
    }

    function merkeFehler(retryAfterSek: number): void {
        backoffMs = backoffMs == 0 ? BACKOFF_START_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS)
        let warten = backoffMs
        // `retry_after` aus der Antwort gewinnt immer gegen den eigenen Takt.
        if (retryAfterSek > 0) warten = Math.max(warten, retryAfterSek * 1000)
        naechsterVersuchMs = control.millis() + warten
        setzeZustand(IotStatus.Fehler)
    }

    function merkeErfolg(): void {
        backoffMs = 0
        naechsterVersuchMs = 0
        setzeZustand(IotStatus.Verbunden)
    }

    // ── Zwischenspeicher und Handler ─────────────────────────────────────────

    function suche(feed: string, von: string, an: string): number {
        for (let i = 0; i < cFeed.length; i++) {
            if (cFeed[i] != feed) continue
            if (von != "" && cVon[i] != von) continue
            if (an != "" && cAn[i] != an) continue
            return i
        }
        return -1
    }

    function nimmAn(feed: string, roh: string, von: string, an: string): void {
        const zahl = parseFloat(roh.trim())
        const istZahl = roh.trim() != "" && !isNaN(zahl)

        let i = -1
        for (let k = 0; k < cFeed.length; k++) {
            if (cFeed[k] == feed) { i = k; break }
        }
        if (i < 0) {
            if (cFeed.length >= CACHE_MAX) {
                cFeed.shift(); cText.shift(); cZahl.shift()
                cIstZahl.shift(); cVon.shift(); cAn.shift()
            }
            cFeed.push(feed); cText.push(roh); cZahl.push(istZahl ? zahl : 0)
            cIstZahl.push(istZahl); cVon.push(von); cAn.push(an)
        } else {
            cText[i] = roh
            cZahl[i] = istZahl ? zahl : 0
            cIstZahl[i] = istZahl
            cVon[i] = von
            cAn[i] = an
        }

        if (eFeed.length >= EMPFANG_MAX) {
            eFeed.shift(); eWert.shift(); eVon.shift(); eAn.shift()
        }
        eFeed.push(feed); eWert.push(roh); eVon.push(von); eAn.push(an)
    }

    function verteileEmpfang(): void {
        while (eFeed.length > 0) {
            const feed = eFeed.shift()
            const roh = eWert.shift()
            const von = eVon.shift()
            const an = eAn.shift()
            const zahl = parseFloat(roh.trim())
            const istZahl = roh.trim() != "" && !isNaN(zahl)
            for (let i = 0; i < zFeeds.length; i++) {
                if (zFeeds[i] == feed && istZahl) zHandler[i](zahl, von, an)
            }
            for (let k = 0; k < tFeeds.length; k++) {
                if (tFeeds[k] == feed) tHandler[k](roh, von, an)
            }
        }
    }

    // ── WLAN ─────────────────────────────────────────────────────────────────

    /**
     * Ein Request trägt beides: die Punkte hin, den Downlink und die Uhrzeit
     * zurück. Der AT-Ablauf ist derselbe wie bei `grove.sendToThinkSpeak`.
     */
    // Zerlegte Serveradresse. Der Chip im Campus trägt die volle Form ein
    // ("http://localhost:8090/api/iot/v1"), ein Kind tippt vielleicht nur den
    // Hostnamen — beides muss zu einem AT-Request führen.
    let adrGeprueft = ""
    let adrHost = ""
    let adrPort = 80
    let adrPfad = "/api/iot/v1"
    let adrTls = false

    function zerlegeAdresse(): void {
        if (adrGeprueft == serverAdresse && adrHost != "") return
        adrGeprueft = serverAdresse
        adrPort = 80
        adrPfad = "/api/iot/v1"
        adrTls = false

        let rest = serverAdresse.trim()
        const schema = rest.indexOf("://")
        if (schema >= 0) {
            const proto = rest.substr(0, schema)
            if (proto == "https") { adrTls = true; adrPort = 443 }
            rest = rest.substr(schema + 3, rest.length - schema - 3)
        }
        const schraeg = rest.indexOf("/")
        if (schraeg >= 0) {
            let pfad = rest.substr(schraeg, rest.length - schraeg)
            // Ein abschließender Schrägstrich würde den Pfad im Request
            // verdoppeln ("/api/iot/v1//ingest").
            while (pfad.length > 1 && pfad.charAt(pfad.length - 1) == "/") {
                pfad = pfad.substr(0, pfad.length - 1)
            }
            if (pfad.length > 1) adrPfad = pfad
            rest = rest.substr(0, schraeg)
        }
        const doppel = rest.indexOf(":")
        if (doppel >= 0) {
            const p = parseFloat(rest.substr(doppel + 1, rest.length - doppel - 1))
            if (!isNaN(p) && p > 0) adrPort = p
            rest = rest.substr(0, doppel)
        }
        adrHost = rest
    }

    function flushWlan(): void {
        if (!grove.wifiOK()) {
            merkeFehler(0)
            return
        }
        setzeZustand(IotStatus.Sendet)

        const anzahl = Math.min(pFeed.length, BATCH_MAX)
        const jetzt = control.millis()
        let koerper = "{\"t\":" + jsonText(referenz)
            + ",\"dev\":" + jsonText(meineGeraeteId())
            + ",\"now\":" + jetzt
            + ",\"d\":["
        for (let i = 0; i < anzahl; i++) {
            if (i > 0) koerper += ","
            // `dt` ist der Abstand zum Absendezeitpunkt und damit negativ:
            // der Server rechnet ts = jetzt + dt. Die Geräteuhr bleibt für die
            // Anzeige, der Server bleibt Zeitherr fürs Speichern.
            koerper += "{\"f\":" + jsonText(pFeed[i])
                + ",\"v\":" + jsonWert(pWert[i])
                + ",\"dt\":" + (pZeit[i] - jetzt)
                + ",\"to\":" + jsonText(pZiel[i])
                + "}"
        }
        koerper += "]}"

        zerlegeAdresse()
        if (adrTls) {
            // Das ESP8285 mit dieser AT-Firmware kann kein TLS. Das laut zu
            // sagen ist die einzige brauchbare Reaktion — sonst sucht jemand
            // den Fehler im WLAN.
            protokolliere("https geht am WLAN-Modul nicht")
            merkeFehler(30)
            return
        }

        grove.sendAtCmd("AT+CIPCLOSE")
        grove.waitAtResponse("OK", "ERROR", "None", 2000)

        grove.sendAtCmd("AT+CIPSTART=\"TCP\",\"" + adrHost + "\"," + adrPort)
        let r = grove.waitAtResponse("OK", "ALREADY CONNECTED", "ERROR", 4000)
        if (r == 0 || r == 3) { merkeFehler(0); return }

        // Zeilenenden wie im Rest der Datei als Escape, nicht als echter
        // Umbruch — genau die Schreibweise, die `sendToIFTTT` schon benutzt.
        const CRLF = "\u000D\u000A"
        const daten = "POST " + adrPfad + "/ingest HTTP/1.1" + CRLF
            + "Host: " + adrHost + (adrPort == 80 ? "" : ":" + adrPort) + CRLF
            + "Content-Type: application/json" + CRLF
            + "Content-Length: " + koerper.length + CRLF
            + "Connection: close" + CRLF
            + CRLF
            + koerper

        grove.sendAtCmd("AT+CIPSEND=" + (daten.length + 2))
        r = grove.waitAtResponse(">", "OK", "ERROR", 2000)
        if (r == 0 || r == 3) { merkeFehler(0); return }

        grove.sendAtCmd(daten)
        r = grove.waitAtResponse("SEND OK", "SEND FAIL", "ERROR", 5000)
        if (r != 1) { merkeFehler(0); return }

        const antwort = liesAntwort(8000)
        if (antwort.indexOf("\"ok\":1") < 0) {
            merkeFehler(zahlNach(antwort, "\"retry_after\":"))
            return
        }

        // Erst jetzt aus dem Puffer nehmen: was nicht ankam, wird wiederholt.
        for (let k = 0; k < anzahl; k++) {
            pFeed.shift(); pWert.shift(); pZiel.shift(); pZeit.shift()
        }

        const ts = zahlNach(antwort, "\"ts\":")
        if (ts > 0) {
            const tzo = zahlNach(antwort, "\"tzo\":")
            setzeZeit(ts, isNaN(tzo) ? 0 : tzo)
        }
        leseDownlink(antwort)
        merkeErfolg()
    }

    function liesAntwort(timeout: number): string {
        let puffer = ""
        const start = control.millis()
        while ((control.millis() - start) < timeout) {
            puffer += serial.readString()
            const k = puffer.indexOf("{\"ok\"")
            if (k >= 0 && puffer.indexOf("}", k) > 0 && puffer.indexOf("]}", k) > 0) break
            if (puffer.length > 1200) break
            basic.pause(50)
        }
        return puffer
    }

    /**
     * Kein JSON-Parser auf dem Gerät: die Antwort wird nach Schlüsseln
     * abgesucht. Die Felder sind kurz und vom Server erzeugt, verschachtelt
     * ist nur `w`.
     */
    function leseDownlink(antwort: string): void {
        const a = antwort.indexOf("\"w\":[")
        if (a < 0) return
        const e = antwort.indexOf("]", a)
        if (e < 0) return
        const liste = antwort.substr(a + 5, e - a - 5)

        let i = 0
        while (i < liste.length) {
            const o = liste.indexOf("{", i)
            if (o < 0) break
            const c = liste.indexOf("}", o)
            if (c < 0) break
            const stueck = liste.substr(o, c - o + 1)
            const feed = textNach(stueck, "\"f\":")
            if (feed != "") {
                let von = textNach(stueck, "\"from\":")
                if (von == "") von = "0"
                const an = textNach(stueck, "\"to\":")
                nimmAn(feed, rohNach(stueck, "\"v\":"), von, an)
            }
            i = c + 1
        }
    }

    /** Zahl hinter einem Schlüssel, NaN wenn der Schlüssel fehlt. */
    function zahlNach(s: string, schluessel: string): number {
        const p = s.indexOf(schluessel)
        if (p < 0) return NaN
        return parseFloat(rohAb(s, p + schluessel.length))
    }

    /** Text hinter einem Schlüssel, ohne Anführungszeichen. */
    function textNach(s: string, schluessel: string): string {
        const p = s.indexOf(schluessel)
        if (p < 0) return ""
        return rohAb(s, p + schluessel.length)
    }

    function rohNach(s: string, schluessel: string): string {
        const p = s.indexOf(schluessel)
        if (p < 0) return ""
        return rohAb(s, p + schluessel.length)
    }

    function rohAb(s: string, start: number): string {
        let i = start
        while (i < s.length && s.charAt(i) == " ") i++
        if (i < s.length && s.charAt(i) == "\"") {
            i++
            let out = ""
            while (i < s.length && s.charAt(i) != "\"") {
                if (s.charAt(i) == "\\" && i + 1 < s.length) i++
                out += s.charAt(i)
                i++
            }
            return out
        }
        let out = ""
        while (i < s.length) {
            const c = s.charAt(i)
            if (c == "," || c == "}" || c == "]") break
            out += c
            i++
        }
        return out.trim()
    }

    // ── Kleinkram ────────────────────────────────────────────────────────────

    /**
     * Zeichenkette als JSON-Text — alles außerhalb von ASCII wird als \\uXXXX
     * geschrieben, damit `Content-Length` (Zeichen) und die Bytezahl auf der
     * Leitung gleich bleiben.
     */
    function jsonText(s: string): string {
        let out = "\""
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i)
            if (c == 34) out += "\\\""
            else if (c == 92) out += "\\\\"
            else if (c < 32 || c > 126) out += "\\u" + hex4(c)
            else out += s.charAt(i)
        }
        return out + "\""
    }

    /** Zahlen bleiben Zahlen, alles andere reist als Text — wie im Ingest-Hook. */
    function jsonWert(roh: string): string {
        const z = parseFloat(roh)
        if (roh != "" && !isNaN(z) && ("" + z) == roh) return roh
        return jsonText(roh)
    }

    function zahlText(w: number): string {
        if (isNaN(w)) return "0"
        return "" + Math.roundWithPrecision(w, 3)
    }

    /** Zeilenumbrüche würden das Zeilenprotokoll zerlegen. */
    function einzeilig(s: string): string {
        if (!s) return ""
        return s.replaceAll("\r", " ").replaceAll("\n", " ")
    }

    /**
     * Feld- und Zielnamen dürfen keinen Doppelpunkt tragen, sonst verrutscht
     * die Zeile. Feedschlüssel sind serverseitig ohnehin auf [a-z0-9_-] begrenzt.
     */
    function feldText(s: string): string {
        if (!s) return ""
        return einzeilig(s).replaceAll(":", "_").trim()
    }

    function zwei(n: number): string {
        return n < 10 ? "0" + n : "" + n
    }

    function hex4(n: number): string {
        const ziffern = "0123456789abcdef"
        let out = ""
        for (let i = 3; i >= 0; i--) out += ziffern.charAt((n >> (i * 4)) & 0xf)
        return out
    }

}
