;; Shared API/TLS/date helpers for `gs` and `gs-mcp`. Never print to stdout here:
;; gs-mcp reserves stdout for JSON-RPC.

(ns godspeed
  (:require [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.java.shell :as shell]
            [clojure.string :as str])
  (:import [java.io ByteArrayInputStream]
           [java.security KeyStore]
           [java.security.cert CertificateFactory]
           [javax.net.ssl SSLContext TrustManagerFactory]))

;; --- Config ---
(def base-url "https://api.godspeedapp.com")
(def task-limit 250)
(def request-timeout-ms 15000)

(defn api-key [] (System/getenv "GODSPEED_API_KEY"))

(defn warn [& msg]
  (binding [*out* *err*] (println (str/join " " msg))))

;; --- TLS / corporate proxy support ---
;; Behind a TLS-intercepting proxy (e.g. Zscaler) the server cert is re-signed
;; by a corporate root CA that lives in the OS keychain, not in bb's bundled
;; truststore, so handshakes fail with "PKIX path building failed". We build an
;; SSLContext whose truststore is sourced from $GODSPEED_CA_BUNDLE (a PEM file)
;; or, on macOS, the keychains: SystemRootCertificates (the public roots) plus
;; System (where the corporate root lives). Returns nil elsewhere so callers
;; fall back to bb's default client.
(def ^:private mac-keychains
  ["/System/Library/Keychains/SystemRootCertificates.keychain"
   "/Library/Keychains/System.keychain"])

(defn- read-pem-certs [pem]
  (when-not (str/blank? pem)
    (let [cf (CertificateFactory/getInstance "X.509")]
      (with-open [in (ByteArrayInputStream. (.getBytes pem "UTF-8"))]
        (vec (.generateCertificates cf in))))))

(defn- ca-certs []
  (try
    (if-let [bundle (System/getenv "GODSPEED_CA_BUNDLE")]
      (read-pem-certs (slurp bundle))
      (when (str/includes? (str/lower-case (System/getProperty "os.name" "")) "mac")
        (mapcat (fn [kc]
                  (let [{:keys [exit out]} (shell/sh "security" "find-certificate" "-a" "-p" kc)]
                    (when (zero? exit) (read-pem-certs out))))
                mac-keychains)))
    (catch Exception _ nil)))

(defn- ssl-context
  "An SSLContext trusting the resolved CA certs, or nil if none are available
   (callers then fall back to bb's default client)."
  []
  (when-let [certs (seq (ca-certs))]
    (let [ks (doto (KeyStore/getInstance (KeyStore/getDefaultType)) (.load nil nil))]
      (doseq [[i c] (map-indexed vector certs)]
        (.setCertificateEntry ks (str "ca-" i) c))
      (let [tmf (doto (TrustManagerFactory/getInstance (TrustManagerFactory/getDefaultAlgorithm))
                  (.init ks))]
        (doto (SSLContext/getInstance "TLS") (.init nil (.getTrustManagers tmf) nil))))))

(def ^:private http-client
  (delay (when-let [ctx (ssl-context)] (http/client {:ssl-context ctx}))))

;; --- HTTP ---
(defn api
  "Call the API. Returns parsed JSON (nil for an empty body). Throws ex-info
   with a readable message on a non-2xx response."
  [method path & {:keys [params body]}]
  (let [resp (http/request (cond-> {:method method
                                    :uri (str base-url path)
                                    :headers {"Authorization" (str "Bearer " (api-key))
                                              "Content-Type" "application/json"}
                                    :query-params (or params {})
                                    :timeout request-timeout-ms
                                    :throw false}
                             body (assoc :body (json/generate-string body))
                             @http-client (assoc :client @http-client)))
        status (:status resp)]
    (when-not (<= 200 status 299)
      (throw (ex-info (str "HTTP " status " from " (name method) " " path
                           (when-not (str/blank? (:body resp)) (str ": " (:body resp))))
                      {:status status})))
    (some-> (:body resp) not-empty (json/parse-string true))))

;; --- Fetchers ---
(defn fetch-tasks
  "There is no pagination, so results are capped at task-limit; warn when hit."
  [& {:keys [status list-id]}]
  (let [params (cond-> {"status" (or status "incomplete")
                        "limit" (str task-limit)}
                 list-id (assoc "list_id" list-id))
        result (api :get "/tasks" :params params)
        tasks (or (:tasks result) result [])]
    (when (>= (count tasks) task-limit)
      (warn (str "Warning: " task-limit " tasks returned (the API limit); some tasks may be missing.")))
    tasks))

(defn fetch-lists []
  (let [result (api :get "/lists")]
    (or (:lists result) result [])))

(defn fetch-labels []
  (let [result (api :get "/labels")]
    (or (:labels result) result [])))

;; --- Dates / "My today" ---
(defn local-date
  "YYYY-MM-DD string for a timeless date, or for a timed ISO timestamp in the local zone."
  [timeless at]
  (or timeless
      (some-> at java.time.Instant/parse
              (.atZone (java.time.ZoneId/systemDefault))
              .toLocalDate str)))

(defn due-date [task] (local-date (:timeless_due_at task) (:due_at task)))
(defn start-date [task] (local-date (:timeless_starts_at task) (:starts_at task)))

(defn today-task?
  "Mirrors the 'My today' smart list: label:wip | due<=today | has:start & start<=today."
  [task wip-id today]
  (let [due (due-date task)
        start (start-date task)]
    (boolean
     (or (and wip-id (some #{wip-id} (:label_ids task)))
         (and due (<= (compare due today) 0))
         (and start (<= (compare start today) 0))))))

(defn find-by-name
  "Id of the item whose :name matches name: exact first, then case-insensitive."
  [name items]
  (or (some #(when (= (:name %) name) (:id %)) items)
      (some #(when (= (str/lower-case (or (:name %) ""))
                      (str/lower-case name)) (:id %)) items)))

(defn today-tasks
  "Tasks for 'My today', sorted by due date."
  [tasks labels]
  (let [wip-id (find-by-name "wip" labels)
        today (str (java.time.LocalDate/now))]
    (->> tasks
         (filter #(today-task? % wip-id today))
         (sort-by #(or (due-date %) "9999")))))

(defn resolve-list-id [name lists] (find-by-name name lists))

(defn resolve-label-ids
  "Resolve comma-separated label names to ids. Throws if any is unknown."
  [names-str labels]
  (->> (str/split names-str #",")
       (map str/trim)
       (remove str/blank?)
       (mapv (fn [n]
               (or (find-by-name n labels)
                   (throw (ex-info (str "label '" n "' not found") {})))))))

(defn fuzzy-match [query tasks]
  (filter #(str/includes? (str/lower-case (or (:title %) ""))
                          (str/lower-case query))
          tasks))

(defn valid-date? [s]
  (boolean (and (string? s)
                (re-matches #"\d{4}-\d{2}-\d{2}" s)
                (try (java.time.LocalDate/parse s) true (catch Exception _ false)))))
