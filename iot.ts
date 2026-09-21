/**
 * IoT — Daten zwischen einem Calliope mini und einem Campus-Dashboard.
 *
 * Zwei Wege, ein Protokoll (siehe calliope-campus/src/lib/services/iot/wire.ts):
 *
 *   Campus (Vorgabe)  zum Verbindungs-Widget im Campus-Tab. Der Campus kennt
 *                     Token und Seriennummer, das Programm braucht beides
 *                     nicht. `serial.redirect` wird hier NIE aufgerufen.
 *                     Dieser Weg hat zwei Rohre, und das Gerät kann nicht
 *                     sehen, welches gerade benutzt wird:
 *                       USB  RAM-Ablage (iotdap.ts) — der Host liest und
 *                            schreibt eine Struktur in unserem Speicher über
 *                            den Debug-Port. Die serielle Leitung war dafür
 *                            unzuverlässig: In ihren 20 Byte Empfangspuffer
 *                            passt nicht einmal eine ganze Protokollzeile, und
 *                            ihn zu vergrößern hat das Senden zerschossen.
 *                       BLE  serielle Leitung, wie gehabt.
 *                     Jede Zeile geht in BEIDE Rohre; der Host nimmt je
 *                     Verbindung eines und überhört das andere.
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
 *   IOT1:r:<umfang>            wessen Werte ankommen sollen: d|g|a
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
 * Wer gemeint ist, wenn gelesen wird — in den Feldern „von" und „an".
 *
 * Eigene Liste und nicht `IotZiel`: Beim SENDEN gibt es nur zwei sinnvolle
 * Ziele (alle, Dashboard), beim LESEN sind es fünf. Und beide Felder sind
 * Texteingänge mit dieser Liste nur als Vorgabe davor — wer ein bestimmtes
 * Gerät meint, zieht die Vorgabe heraus und schreibt die Geräte-ID hinein
 * (oder steckt eine Variable an).
 *
 * „alle außer mir" gibt es, weil „andere Geräte" das Dashboard NICHT
 * einschließt — ein Dashboard ist kein Gerät. Wer den Sollwert und die Werte
 * der Klasse will, aber nicht sein eigenes Echo, meint diese Zeile.
 */
enum IotWer {
    //% block="alle"
    Alle = 0,
    //% block="Dashboard"
    Dashboard = 1,
    //% block="andere Geräte"
    AndereGeraete = 2,
    //% block="alle außer mir"
    AlleAusserMir = 3,
    //% block="nur dieses Gerät"
    NurDiesesGeraet = 4
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

    // RAM-Ablage (iotdap.ts). Ein Platz je Richtung, eine Zeile je Platz.
    // Höchstens 5 × 2 ms Warten je Zeile, wenn der Host den Platz noch nicht
    // geleert hat — zusammen mit den gut 3 ms, die das serielle Schreiben der
    // vorigen Zeile ohnehin gedauert hat, reicht das für einen Host, der im
    // Millisekundentakt nachsieht. Wer langsamer nachsieht, verliert Zeilen
    // statt das Programm auszubremsen.
    const ABLAGE_VERSUCHE = 5
    const ABLAGE_WARTE_MS = 2
    // So viele Zeilen werden je Runde des Hintergrund-Fibers abgeholt. Meist
    // liegt nur eine da (der Host legt erst nach unserem Freigeben nach); die
    // Schranke hält den Fiber davon ab, an einem sehr schnellen Host hängen zu
    // bleiben, statt zwischendurch zu senden.
    const ABLAGE_JE_RUNDE = 4

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

    // Was im Protokoll steht, wenn in einem „von"/„an"-Feld eine Vorgabe
    // gewählt ist. Der Stern kann in keiner Geräte-ID vorkommen (fünf
    // Buchstaben, oder „mini-…"/„sim-…" aus dem Campus), also kann eine
    // getippte ID mit keiner Vorgabe kollidieren.
    const WER_ALLE = ""
    const WER_DASHBOARD = "0"
    const WER_ANDERE = "*g"
    const WER_OHNE_MICH = "*o"
    const WER_ICH = "*i"

    // Woraus sich das Abonnement ergibt. KEIN eigener Block dafür: Was ein
    // Programm lesen will, steht an seinen Leseblöcken, und zweimal dasselbe
    // zu fragen ist eine Einstellung zu viel. Die beiden Flaggen werden nur
    // GESETZT, nie zurückgenommen — ein Programm, das an einer Stelle das
    // Dashboard und an einer anderen die Klasse liest, braucht beides.
    let willDashboard = false
    let willGeraete = false
    let angesagterUmfang = ""

    let gestartet = false
    let hoertZu = false
    let zustand = IotStatus.Getrennt

    let naechsterFlushMs = 0
    // Zeitpunkt der letzten Sendung — der Boden zwischen zwei Sendungen.
    let letzterSendeMs = 0
    let naechsterVersuchMs = 0
    let backoffMs = 0
    let sofort = false
    // Anmeldung steht aus. Sie wird NICHT synchron beim Start geschickt: In den
    // ersten Millisekunden nach dem Reset ist die USB-Seite noch nicht bereit,
    // und genau dort entstand die verstümmelte Zeile im Log.
    let halloFaellig = false

    // Sendepuffer (parallele Felder statt Objekten: kein Allozieren je Punkt)
    let pFeed: string[] = []
    let pWert: string[] = []
    let pZiel: string[] = []
    let pZeit: number[] = []

    // Zuletzt bekannter Wert je (Feed, Absender, Empfänger). `lese` liest hier,
    // nie im Netz.
    //
    // Der Schlüssel ist das Tripel und nicht der Feed allein. Vorher gab es
    // genau einen Platz je Feed, dessen Absender der jeweils letzte Schreiber
    // überschrieb — `suche` filtert aber nach Feed UND Absender, also lieferte
    // `lese "temperatur" von <Gerät>` eine 0, sobald irgendein anderes Gerät
    // zuletzt geschrieben hatte. Solange nur das Dashboard schrieb, fiel das
    // nicht auf: ein Absender, ein Platz.
    //
    // Mit „andere Geräte" belegt jedes sendende Gerät einen eigenen Platz. Bei
    // CACHE_MAX fliegt der älteste Eintrag — in einer großen Klasse kann das
    // ein Gerät sein, das noch gebraucht wird. Das ist die bewusste Grenze:
    // Speicher auf dem mini ist knapper als Vollständigkeit wertvoll ist.
    let cFeed: string[] = []
    let cText: string[] = []
    let cZahl: number[] = []
    let cIstZahl: boolean[] = []
    let cVon: string[] = []
    let cAn: string[] = []
    // Wann der Eintrag zuletzt geschrieben wurde. Damit `lese` ohne
    // Absenderfilter den NEUESTEN Treffer liefert und nicht den, der zufällig
    // vorne im Feld steht.
    let cZeit: number[] = []

    // Empfangene Werte warten hier auf den Hintergrund-Fiber. Direkt aus dem
    // Serial-Fiber heraus aufzurufen wäre bequemer, aber ein `zeige Zahl` im
    // Handler hielte dann die Leitung an und der nächste Downlink ginge verloren.
    let eFeed: string[] = []
    let eWert: string[] = []
    let eVon: string[] = []
    let eAn: string[] = []

    let zFeeds: string[] = []
    let zVon: string[] = []
    let zHandler: ((wert: number, von: string, an: string) => void)[] = []
    let tFeeds: string[] = []
    let tVon: string[] = []
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
        // Beides, und zwar immer: Das Gerät kann nicht erkennen, ob am anderen
        // Ende ein USB-Kabel oder eine BLE-Strecke hängt. Der Host entscheidet
        // je Verbindung, welches Rohr er liest — über USB die RAM-Ablage (und
        // überhört die IOT-Zeilen auf der seriellen Leitung), über BLE
        // umgekehrt. Doppelt zu schreiben kostet fast nichts: Ohne lauschenden
        // Host ist die Ablage ein memcpy in den eigenen Speicher.
        //
        // Die Ablage zuerst: Das Schreiben auf die serielle Leitung blockiert
        // bis die Bytes draußen sind (bei 115200 Baud gute 3 ms je Zeile) und
        // gibt dem Host damit von selbst die Zeit, die Ablage zu leeren, bevor
        // die nächste Zeile kommt.
        legeInAblage(zeile)
        serial.writeString(zeile)
        serial.writeString("\r\n")
    }

    /**
     * Legt eine Zeile in die RAM-Ablage. Der Platz fasst genau eine Zeile: Wer
     * schreibt, muss warten, bis der Host die vorige geholt hat.
     *
     * Gewartet wird nur, wenn überhaupt jemand abholt. Sonst wäre der erste
     * belegte Platz ein Dauerzustand — niemand holt etwas — und jede einzelne
     * Zeile eines Schülerprogramms hinge kurz fest, ohne dass das irgendwem
     * nützte.
     */
    function legeInAblage(zeile: string): void {
        if (iotdap.schreibe(zeile)) return
        if (!iotdap.hoertJemandZu()) return
        // Ein Host, der zuhört, hat die vorige Zeile in wenigen Millisekunden
        // geholt. Ohne dieses kurze Warten ginge beim Leeren des Sendepuffers
        // (bis zu 24 Zeilen hintereinander) alles bis auf die erste verloren.
        for (let versuch = 0; versuch < ABLAGE_VERSUCHE; versuch++) {
            basic.pause(ABLAGE_WARTE_MS)
            if (iotdap.schreibe(zeile)) return
        }
        // Aufgegeben. Über USB fehlt diese eine Zeile — besser als ein Programm,
        // das an einem zähen Rückkanal hängen bleibt. Auf die serielle Leitung
        // geht sie gleich danach ohnehin noch raus.
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
        if (weg == IotWeg.Campus) halloFaellig = true
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
        if (weg == IotWeg.Campus) halloFaellig = true
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
        // Der Lese-Umfang geht VOR der Referenzprüfung raus. Über den Weg
        // „Campus" darf das Dashboard-Feld leer bleiben — dann nimmt der Campus
        // die Referenz aus dem geöffneten Programm —, aber die Frage „wessen
        // Werte will ich?" kann nur dieses Programm beantworten. Hinter dem
        // `return` unten wäre sie in genau dem Fall verloren.
        emit(WIRE + "r:" + umfangCode())
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
     * serielle Leitung dem Funkmodul, dort passiert bis auf Weiteres nichts.
     * Die RAM-Ablage (iotdap.ts) gäbe es zwar auch dort — sie hängt nicht an
     * der seriellen Leitung —, aber der WLAN-Weg bleibt bewusst unangetastet:
     * eine Änderung nach der anderen.
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
        const zielFeld = feldText(ziel)
        pFeed.push(schluessel)
        pWert.push(wert)
        pZiel.push(zielFeld)
        pZeit.push(control.millis())
        // Der eigene Wert geht sofort in den Zwischenspeicher, nicht erst wenn
        // er über den Server zurückkäme. Sonst zeigt „lese tmp" direkt nach
        // „sende tmp" den alten Wert — eine Runde über Server und nächste
        // Anfrage später wäre er da, und genau das sieht wie ein Fehler aus.
        // Der Server braucht eigene Zeilen deshalb nie zurückzuschicken.
        //
        // NUR der Zwischenspeicher: `wenn … empfangen` ist ein Auslöser für
        // EINGEHENDE Werte und darf nicht auf der eigenen Ausgabe feuern.
        merkeEigenen(schluessel, wert, zielFeld)
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
    //% block="wenn $feed von $quelle empfangen"
    //% draggableParameters="reporter"
    //% feed.defl="temperatur"
    //% quelle.shadow="iot_wer"
    //% group="Empfangen"
    //% weight=80 blockGap=8
    export function beiWert(
        feed: string,
        quelle: string,
        handler: (wert: number, von: string, an: string) => void
    ): void {
        starte()
        // Das Feld heißt `quelle` und nicht `von`, obwohl es „von" anzeigt: Der
        // Rumpf hat mit `draggableParameters` schon einen ziehbaren Parameter
        // `von` (wer den Wert geschickt hat). Zwei gleich benannte Eingänge an
        // einem Block lässt Blockly nicht zu — es verwirft den ziehbaren und
        // meldet „Ignoring non-existent input HANDLER_DRAG_PARAM_von".
        //
        // Sichtbar im Block und nicht hinter einem „+": Dieses Feld entscheidet,
        // was überhaupt ankommt, und eine unsichtbare Vorgabe „alle" würde in
        // einer Klasse 27 fremde Messreihen in einen Auslöser schütten, der
        // nach einem Sollwert fragt. pxt verlangt außerdem, dass der
        // Rumpf-Parameter zuletzt steht — optional davor geht nicht.
        const vonFeld = feldText(quelle)
        merkeLeseWunsch(vonFeld)
        zFeeds.push(feldText(feed))
        zVon.push(vonFeld)
        zHandler.push(handler)
    }

    /**
     * Läuft, wenn für diese Messreihe ein Text eintrifft.
     * @param feed Name der Messreihe, z.B. "nachricht"
     */
    //% blockId=iot_bei_text
    //% block="wenn Text $feed von $quelle empfangen"
    //% draggableParameters="reporter"
    //% feed.defl="nachricht"
    //% quelle.shadow="iot_wer"
    //% group="Empfangen"
    //% weight=79 blockGap=8
    export function beiText(
        feed: string,
        quelle: string,
        handler: (text: string, von: string, an: string) => void
    ): void {
        starte()
        // `quelle`, nicht `von` — siehe beiWert: der Rumpf hat den ziehbaren
        // Parameter `von` schon.
        const vonFeld = feldText(quelle)
        merkeLeseWunsch(vonFeld)
        tFeeds.push(feldText(feed))
        tVon.push(vonFeld)
        tHandler.push(handler)
    }

    /**
     * Übersetzt die Vorgabe eines „von"/„an"-Feldes in das, was im Protokoll
     * steht. Versteckt, weil der Baustein nur als Vorlage in den Feldern sitzt
     * — herausgezogen bleibt ein gewöhnlicher Texteingang, in den eine
     * Geräte-ID oder eine Variable passt.
     */
    //% blockId=iot_wer
    //% block="$wer"
    //% blockHidden=true
    //% weight=1
    export function werCode(wer: IotWer): string {
        if (wer == IotWer.Dashboard) return WER_DASHBOARD
        if (wer == IotWer.AndereGeraete) return WER_ANDERE
        if (wer == IotWer.AlleAusserMir) return WER_OHNE_MICH
        if (wer == IotWer.NurDiesesGeraet) return WER_ICH
        return WER_ALLE
    }

    /**
     * Merkt sich, was ein Leseblock haben will, und sagt es dem Campus.
     *
     * Das Abonnement ergibt sich daraus — es gibt keinen Block, der es
     * getrennt einstellt. Ein Feld, das auf „nur dieses Gerät" steht, braucht
     * gar kein Abonnement: die eigenen Werte stehen schon beim Senden im
     * Zwischenspeicher.
     */
    function merkeLeseWunsch(von: string): void {
        if (von == WER_ICH) return
        if (von == WER_DASHBOARD) willDashboard = true
        else if (von == WER_ANDERE) willGeraete = true
        else if (von == WER_ALLE || von == WER_OHNE_MICH) { willDashboard = true; willGeraete = true }
        // Eine getippte Geräte-ID: ein Gerät ist ein Gerät.
        else willGeraete = true
        sageUmfangAn()
    }

    /** Der Buchstabe, der im Protokoll und im WLAN-Request steht. */
    function umfangCode(): string {
        if (willDashboard && willGeraete) return "a"
        if (willGeraete) return "g"
        return "d"
    }

    function sageUmfangAn(): void {
        const code = umfangCode()
        if (code == angesagterUmfang) return
        angesagterUmfang = code
        starte()
        hoerZu()
        // Über die Anmeldung, damit auch eine Sonde („?") die Antwort erneut
        // mitschickt. Der Server filtert sonst weiter nach der alten Frage.
        if (weg == IotWeg.Campus) halloFaellig = true
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
    //% von.shadow="iot_wer"
    //% an.shadow="iot_wer"
    //% group="Empfangen"
    //% weight=70 blockGap=8
    export function lese(feed: string, von?: string, an?: string): number {
        const vonFeld = feldText(von)
        merkeLeseWunsch(vonFeld)
        const i = suche(feldText(feed), vonFeld, feldText(an))
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
    //% von.shadow="iot_wer"
    //% an.shadow="iot_wer"
    //% group="Empfangen"
    //% weight=69 blockGap=8
    export function leseText(feed: string, von?: string, an?: string): string {
        const vonFeld = feldText(von)
        merkeLeseWunsch(vonFeld)
        const i = suche(feldText(feed), vonFeld, feldText(an))
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

        // Hier stand `serial.setRxBufferSize(128)`. Es ist absichtlich weg.
        //
        // Der Grund dafür war richtig: Der Empfangspuffer fasst per Vorgabe
        // 20 Byte (CODAL_SERIAL_DEFAULT_BUFFER_SIZE) und damit weniger als eine
        // einzige Uhrzeitzeile ("IOT1:t:1790016481:120" = 21) — ankommende
        // Zeilen wurden schlicht abgeschnitten. Das Mittel war es nicht: Beim
        // Sendepuffer (`setTxBufferSize`) verstummte das Gerät vollständig, und
        // auch der vergrößerte Empfangspuffer steht im Verdacht, das Senden
        // gestört zu haben. Ein Verdacht, den niemand ausräumen konnte, ist bei
        // einer Leitung, auf der alles läuft, Grund genug, ihn loszuwerden.
        //
        // Der Rückkanal über USB hängt nicht mehr an dieser Leitung, sondern an
        // der RAM-Ablage (iotdap.ts) — dort passt eine Zeile ganz hinein. Über
        // BLE bleibt die serielle Leitung der Weg, und dort gilt die 20-Byte-
        // Grenze wieder: Lange Zeilen können abgeschnitten ankommen.
        naechsterFlushMs = control.millis() + taktMs
        hoerZu()
        control.inBackground(function () {
            while (true) {
                basic.pause(100)
                holeAusAblage()
                verteileEmpfang()
                if (halloFaellig) { halloFaellig = false; sendeHallo() }
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
     * Rückkanal der RAM-Ablage — das Gegenstück zu `hoerZu` für den USB-Weg.
     *
     * Gefragt wird, statt geweckt zu werden: Der Host legt eine Zeile in den
     * Speicher, ohne dass auf dem Gerät irgendetwas auslöst. Der
     * Hintergrund-Fiber läuft ohnehin alle 100 ms, also sieht er hier nach. Das
     * ist die Verzögerung, mit der eine Zeile vom Campus ankommt; für Sollwerte
     * und die Uhrzeit ist sie bedeutungslos.
     *
     * Nur auf dem Weg „Campus", genau wie beim seriellen Rückkanal: Über WLAN
     * kommen Antworten aus dem HTTP-Request, und ein zweiter Weg, der Werte
     * einspeist, wäre eine stille Zusatzquelle, die niemand bestellt hat.
     */
    function holeAusAblage(): void {
        if (weg != IotWeg.Campus) return
        for (let i = 0; i < ABLAGE_JE_RUNDE; i++) {
            let zeile = iotdap.lies()
            if (zeile == "") return
            // Der Vertrag sagt „eine Zeile ohne Zeilenende". Käme doch eines
            // mit, stünde es im letzten Feld — und das letzte Feld ist der Wert.
            while (zeile.length > 0) {
                const letztes = zeile.charAt(zeile.length - 1)
                if (letztes != "\n" && letztes != "\r") break
                zeile = zeile.substr(0, zeile.length - 1)
            }
            empfangeZeile(zeile)
        }
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
            // Nur noch die Unixsekunden. Die Zeitzone kommt als eigene Zeile
            // („z"), weil beides zusammen 21 Byte wären — eines mehr, als der
            // serielle Empfangspuffer über BLE fasst. Ältere Hosts hängen die
            // Zone noch mit einem Doppelpunkt an; das wird weiter gelesen.
            let sekText = rest
            const p = rest.indexOf(":")
            if (p >= 0) {
                sekText = rest.substr(0, p)
                const tzoAlt = parseFloat(rest.substr(p + 1, rest.length - p - 1))
                if (!isNaN(tzoAlt)) uhrZoneMin = tzoAlt
            }
            const sek = parseFloat(sekText)
            if (isNaN(sek)) return
            setzeZeit(sek, uhrZoneMin)
            setzeZustand(IotStatus.Verbunden)
            return
        }
        if (art == "z") {
            // Zeitzone in Minuten. Kann vor oder nach der Uhrzeit eintreffen,
            // darum verstellt sie nur den Versatz und nicht die Uhr selbst.
            const zone = parseFloat(rest)
            if (!isNaN(zone)) uhrZoneMin = zone
            return
        }
        if (art == "?") {
            // Der Campus fragt, wer hier hängt. Das passiert, wenn er später
            // dazukommt als das Programm — dann ist unsere Startmeldung längst
            // verklungen. Ohne diese Antwort läuft ein geflashtes Gerät ins
            // Leere, solange niemand den Editor öffnet.
            halloFaellig = true
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

    /**
     * Trifft ein „von"/„an"-Feld auf diesen Absender bzw. Empfänger zu?
     *
     * Ein leeres Feld heißt „alle" und trifft immer. Die Sternvorgaben werden
     * gegen die eigene Geräte-ID gerechnet; alles andere ist eine getippte ID
     * und wird genau verglichen.
     *
     * „nur dieses Gerät" im Feld „an" meint AUSDRÜCKLICH adressiert: eine
     * Rundsendung (`an` leer) trifft nicht zu, obwohl sie auch an dieses Gerät
     * ging. Sonst wäre „an mich" von „an alle" nicht zu unterscheiden.
     */
    function passt(muster: string, wert: string): boolean {
        if (muster == WER_ALLE) return true
        if (muster == WER_ICH) return wert == meineGeraeteId()
        if (muster == WER_OHNE_MICH) return wert != meineGeraeteId()
        if (muster == WER_ANDERE) return wert != meineGeraeteId() && wert != WER_DASHBOARD
        return wert == muster
    }

    /**
     * Der passende Eintrag, und zwar der NEUESTE. Ohne Absenderfilter treffen
     * bei „andere Geräte" mehrere Plätze zu; „der erste im Feld" wäre dann der
     * am längsten unveränderte — also gerade der falsche.
     */
    function suche(feed: string, von: string, an: string): number {
        let treffer = -1
        for (let i = 0; i < cFeed.length; i++) {
            if (cFeed[i] != feed) continue
            if (!passt(von, cVon[i])) continue
            if (!passt(an, cAn[i])) continue
            if (treffer < 0 || cZeit[i] > cZeit[treffer]) treffer = i
        }
        return treffer
    }

    /**
     * Ein selbst gesendeter Wert, damit er sofort lesbar ist. Geht NICHT in die
     * Empfangsschlange: `wenn … empfangen` ist ein Auslöser für eingehende
     * Werte.
     */
    function merkeEigenen(feed: string, roh: string, an: string): void {
        schreibeCache(feed, roh, meineGeraeteId(), an)
    }

    function nimmAn(feed: string, roh: string, von: string, an: string): void {
        schreibeCache(feed, roh, von, an)

        if (eFeed.length >= EMPFANG_MAX) {
            eFeed.shift(); eWert.shift(); eVon.shift(); eAn.shift()
        }
        eFeed.push(feed); eWert.push(roh); eVon.push(von); eAn.push(an)
    }

    function schreibeCache(feed: string, roh: string, von: string, an: string): void {
        const zahl = parseFloat(roh.trim())
        const istZahl = roh.trim() != "" && !isNaN(zahl)

        // Das Tripel ist der Schlüssel: zwei Geräte, die denselben Feed
        // schreiben, sind zwei Einträge und nicht einer, der hin und her
        // kippt.
        let i = -1
        for (let k = 0; k < cFeed.length; k++) {
            if (cFeed[k] == feed && cVon[k] == von && cAn[k] == an) { i = k; break }
        }
        if (i < 0) {
            if (cFeed.length >= CACHE_MAX) {
                cFeed.shift(); cText.shift(); cZahl.shift()
                cIstZahl.shift(); cVon.shift(); cAn.shift(); cZeit.shift()
            }
            cFeed.push(feed); cText.push(roh); cZahl.push(istZahl ? zahl : 0)
            cIstZahl.push(istZahl); cVon.push(von); cAn.push(an)
            cZeit.push(control.millis())
        } else {
            cText[i] = roh
            cZahl[i] = istZahl ? zahl : 0
            cIstZahl[i] = istZahl
            cZeit[i] = control.millis()
        }
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
                if (zFeeds[i] != feed || !istZahl) continue
                if (!passt(zVon[i], von)) continue
                zHandler[i](zahl, von, an)
            }
            for (let k = 0; k < tFeeds.length; k++) {
                if (tFeeds[k] != feed) continue
                if (!passt(tVon[k], von)) continue
                tHandler[k](roh, von, an)
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
        // `scope` steht auch hier, nicht nur auf der Campus-Leitung: Der
        // Campus-Tab schickt dasselbe Feld weiter, wenn er wörtlich
        // weiterleitet. Beide Wege müssen für dasselbe Programm dieselbe
        // Antwort erzeugen, sonst verhält sich ein hier getestetes Programm
        // anders, sobald das WLAN-Modul dran ist.
        let koerper = "{\"t\":" + jsonText(referenz)
            + ",\"dev\":" + jsonText(meineGeraeteId())
            + ",\"now\":" + jetzt
            + ",\"scope\":" + jsonText(umfangCode())
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
