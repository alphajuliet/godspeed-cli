#!/usr/bin/env bb

(ns gs
  (:require [babashka.http-client :as http]
            [cheshire.core :as json]
            [clojure.string :as str]))

;; --- Config ---
(def base-url "https://api.godspeedapp.com")

(defn api-key []
  (or (System/getenv "GODSPEED_API_KEY")
      (do (println "Error: GODSPEED_API_KEY environment variable not set")
          (System/exit 1))))

(defn auth-headers []
  {"Authorization" (str "Bearer " (api-key))
   "Content-Type" "application/json"})

;; --- HTTP helpers ---
(defn GET [path & {:keys [params]}]
  (let [url (str base-url path)
        resp (http/get url {:headers (auth-headers)
                            :query-params (or params {})})]
    (json/parse-string (:body resp) true)))

(defn POST [path body]
  (let [url (str base-url path)
        resp (http/post url {:headers (auth-headers)
                             :body (json/generate-string body)})]
    (json/parse-string (:body resp) true)))

(defn PATCH [path body]
  (let [url (str base-url path)
        resp (http/patch url {:headers (auth-headers)
                              :body (json/generate-string body)})]
    (json/parse-string (:body resp) true)))

(defn DELETE [path]
  (let [url (str base-url path)]
    (http/delete url {:headers (auth-headers)})))

;; --- Task helpers ---
(defn fetch-tasks [& {:keys [status list-id]}]
  (let [params (cond-> {"status" (or status "incomplete")
                        "limit" "250"}
                 list-id (assoc "list_id" list-id))
        result (GET "/tasks" :params params)]
    (or (:tasks result) result [])))

(defn fetch-lists []
  (let [result (GET "/lists")]
    (or (:lists result) result [])))

(defn fetch-labels []
  (let [result (GET "/labels")]
    (or (:labels result) result [])))

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

(defn today-tasks [tasks labels]
  (let [wip-id (some #(when (= "wip" (str/lower-case (or (:name %) ""))) (:id %)) labels)
        today (str (java.time.LocalDate/now))]
    (->> tasks
         (filter #(today-task? % wip-id today))
         (sort-by #(or (due-date %) "9999")))))

(defn resolve-list-id [name lists]
  ;; exact match first, then case-insensitive
  (or (some #(when (= (:name %) name) (:id %)) lists)
      (some #(when (= (str/lower-case (or (:name %) ""))
                      (str/lower-case name)) (:id %)) lists)))

(defn fuzzy-match [query tasks]
  (filter #(str/includes? (str/lower-case (or (:title %) ""))
                          (str/lower-case query))
          tasks))

(defn short-id [id]
  (subs (str id) 0 (min 5 (count (str id)))))

(defn format-task [task lists]
  (let [id (short-id (:id task))
        title (:title task)
        due (due-date task)
        list-id (:list_id task)
        list-name (when list-id
                    (some #(when (= (:id %) list-id) (:name %)) lists))]
    (str "[" id "] " title
         (when due (str " (due: " due ")"))
         (when (and list-name (not= list-name "Inbox"))
           (str " [" list-name "]")))))

;; --- Argument parsing ---
(defn parse-flags [args]
  (loop [remaining args
         flags {}
         positional []]
    (if (empty? remaining)
      (assoc flags :positional positional)
      (let [arg (first remaining)
            rest-args (rest remaining)]
        (if (str/starts-with? arg "--")
          (let [key (keyword (subs arg 2))
                val (first rest-args)]
            (recur (rest rest-args) (assoc flags key val) positional))
          (recur rest-args flags (conj positional arg)))))))

;; --- Commands ---
(defn cmd-list [args]
  (let [flags (parse-flags args)
        lists (fetch-lists)
        list-id (when-let [list-name (:list flags)]
                  (or (resolve-list-id list-name lists)
                      (do (println (str "Error: list '" (:list flags) "' not found"))
                          (System/exit 1))))
        status (or (:status flags) "incomplete")
        tasks (fetch-tasks :status status :list-id list-id)
        sorted (sort-by :order_index tasks)
        min-level (if (seq sorted) (apply min (map #(or (:indent_level %) 0) sorted)) 0)]
    (if (empty? sorted)
      (println "No tasks found.")
      (doseq [task sorted]
        (let [indent (str/join (repeat (* 2 (- (or (:indent_level task) 0) min-level)) " "))]
          (println (str indent (format-task task lists))))))))

(defn cmd-today [_args]
  (let [lists (fetch-lists)
        tasks (today-tasks (fetch-tasks) (fetch-labels))]
    (if (empty? tasks)
      (println "Nothing due today.")
      (doseq [task tasks]
        (println (format-task task lists))))))

(defn cmd-add [args]
  (let [flags (parse-flags args)
        positional (:positional flags)
        title (str/join " " positional)]
    (when (str/blank? title)
      (println "Error: task title required")
      (System/exit 1))
    (let [lists (fetch-lists)
          list-id (when-let [list-name (:list flags)]
                    (or (resolve-list-id list-name lists)
                        (do (println (str "Error: list '" list-name "' not found"))
                            (System/exit 1))))
          body (cond-> {:title title}
                 (:due flags) (assoc :timeless_due_at (:due flags))
                 list-id (assoc :list_id list-id)
                 (:notes flags) (assoc :notes (:notes flags))
                 (:label flags) (assoc :label (:label flags)))]
      (POST "/tasks" body)
      (println (str "Created: " title)))))

(defn cmd-done [args]
  (let [query (str/join " " args)]
    (when (str/blank? query)
      (println "Error: search query required")
      (System/exit 1))
    (let [lists (fetch-lists)
          tasks (fetch-tasks)
          matches (fuzzy-match query tasks)]
      (cond
        (empty? matches)
        (do (println (str "No tasks matching '" query "'"))
            (System/exit 1))

        (> (count matches) 1)
        (do (doseq [task matches]
              (println (format-task task lists)))
            (println "Multiple matches — be more specific")
            (System/exit 1))

        :else
        (let [task (first matches)]
          (PATCH (str "/tasks/" (:id task)) {:is_complete true})
          (println (str "Completed: " (:title task) " [" (short-id (:id task)) "]")))))))

(defn cmd-delete [args]
  (let [query (str/join " " args)]
    (when (str/blank? query)
      (println "Error: search query required")
      (System/exit 1))
    (let [lists (fetch-lists)
          tasks (fetch-tasks)
          matches (fuzzy-match query tasks)]
      (cond
        (empty? matches)
        (do (println (str "No tasks matching '" query "'"))
            (System/exit 1))

        (> (count matches) 1)
        (do (doseq [task matches]
              (println (format-task task lists)))
            (println "Multiple matches — be more specific")
            (System/exit 1))

        :else
        (let [task (first matches)]
          (DELETE (str "/tasks/" (:id task)))
          (println (str "Deleted: " (:title task))))))))

(defn cmd-lists [_args]
  (let [lists (->> (fetch-lists)
                   (filter #(#{"list" "inbox"} (:list_type %))))]
    (if (empty? lists)
      (println "No lists found.")
      (doseq [lst lists]
        (println (:name lst))))))

(defn cmd-help []
  (println "gs — Godspeed task manager CLI")
  (println)
  (println "Usage:")
  (println "  gs list [--list <name>] [--status complete|incomplete]")
  (println "  gs today")
  (println "  gs lists")
  (println "  gs add <title> [--due YYYY-MM-DD] [--list <name>] [--notes <text>] [--label <name>]")
  (println "  gs done <query>")
  (println "  gs delete <query>")
  (println)
  (println "Environment:")
  (println "  GODSPEED_API_KEY  Required. Your Godspeed API key."))

;; --- Dispatch ---
(let [[cmd & args] *command-line-args*]
  (case cmd
    "list"   (cmd-list args)
    "today"  (cmd-today args)
    "lists"  (cmd-lists args)
    "add"    (cmd-add args)
    "done"   (cmd-done args)
    "delete" (cmd-delete args)
    (cmd-help)))
