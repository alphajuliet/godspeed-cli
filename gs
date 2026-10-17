#!/usr/bin/env bb

(ns gs
  (:require [babashka.classpath :as cp]
            [clojure.java.io :as io]
            [clojure.string :as str]))

;; Shared code lives in godspeed.clj next to this script (resolving symlinks).
(cp/add-classpath (str (.getParentFile (.getCanonicalFile (io/file *file*)))))
(require '[godspeed :as g :refer [api fetch-tasks fetch-lists fetch-labels due-date
                                  resolve-list-id fuzzy-match]])

(defn die [& msg]
  (binding [*out* *err*] (println (str/join " " msg)))
  (System/exit 1))

;; --- Task helpers ---
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
(defn parse-flags
  "`--key value` and `--key=value` set flags; everything else is positional.
   A flag with no value is an error."
  [args]
  (loop [remaining args
         flags {}
         positional []]
    (if (empty? remaining)
      (assoc flags :positional positional)
      (let [arg (first remaining)
            rest-args (rest remaining)]
        (if (str/starts-with? arg "--")
          (let [[k inline] (str/split (subs arg 2) #"=" 2)
                val (if inline inline (first rest-args))
                rest-args (if inline rest-args (rest rest-args))]
            (when (nil? val) (die (str "Error: --" k " requires a value")))
            (recur rest-args (assoc flags (keyword k) val) positional))
          (recur rest-args flags (conj positional arg)))))))

(defn list-id-for [flags lists]
  (when-let [list-name (:list flags)]
    (or (resolve-list-id list-name lists)
        (die (str "Error: list '" list-name "' not found")))))

;; --- Commands ---
(defn cmd-list [args]
  (let [flags (parse-flags args)
        status (or (:status flags) "incomplete")
        _ (when-not (#{"complete" "incomplete"} status)
            (die "Error: --status must be 'complete' or 'incomplete'"))
        lists (fetch-lists)
        tasks (fetch-tasks :status status :list-id (list-id-for flags lists))
        sorted (sort-by :order_index tasks)
        min-level (if (seq sorted) (apply min (map #(or (:indent_level %) 0) sorted)) 0)]
    (if (empty? sorted)
      (println "No tasks found.")
      (doseq [task sorted]
        (let [indent (str/join (repeat (* 2 (- (or (:indent_level task) 0) min-level)) " "))]
          (println (str indent (format-task task lists))))))))

(defn cmd-today [_args]
  (let [[lists tasks labels] (map deref [(future (fetch-lists))
                                         (future (fetch-tasks))
                                         (future (fetch-labels))])
        tasks (g/today-tasks tasks labels)]
    (if (empty? tasks)
      (println "Nothing due today.")
      (doseq [task tasks]
        (println (format-task task lists))))))

(defn cmd-add [args]
  (let [flags (parse-flags args)
        title (str/join " " (:positional flags))]
    (when (str/blank? title) (die "Error: task title required"))
    (when (and (:due flags) (not (g/valid-date? (:due flags))))
      (die "Error: --due must be a valid YYYY-MM-DD date"))
    (let [list-id (when (:list flags) (list-id-for flags (fetch-lists)))
          label-ids (when (:label flags)
                      (try (g/resolve-label-ids (:label flags) (fetch-labels))
                           (catch clojure.lang.ExceptionInfo e
                             (die (str "Error: " (ex-message e))))))
          body (cond-> {:title title}
                 (:due flags) (assoc :timeless_due_at (:due flags))
                 list-id (assoc :list_id list-id)
                 (:notes flags) (assoc :notes (:notes flags))
                 label-ids (assoc :label_ids label-ids))]
      (api :post "/tasks" :body body)
      (println (str "Created: " title)))))

(defn pick-task
  "Find the single incomplete task for a done/delete command, or exit.
   `--id <prefix>` matches by id prefix; otherwise `query` is a title substring
   (an exact title match wins over other substring matches)."
  [args]
  (let [flags (parse-flags args)
        query (str/join " " (:positional flags))
        id-prefix (:id flags)]
    (when (and (str/blank? query) (str/blank? id-prefix))
      (die "Error: search query or --id required"))
    (let [lists (fetch-lists)
          tasks (fetch-tasks)
          matches (if id-prefix
                    (filter #(str/starts-with? (str (:id %)) id-prefix) tasks)
                    (let [ms (fuzzy-match query tasks)
                          exact (filter #(= (str/lower-case (or (:title %) "")) (str/lower-case query)) ms)]
                      (if (= 1 (count exact)) exact ms)))]
      (cond
        (empty? matches)
        (die (str "No tasks matching '" (or id-prefix query) "'"))

        (> (count matches) 1)
        (do (doseq [task matches] (println (format-task task lists)))
            (die "Multiple matches — be more specific (or use --id <id prefix>)"))

        :else (first matches)))))

(defn cmd-done [args]
  (let [task (pick-task args)]
    (api :patch (str "/tasks/" (:id task)) :body {:is_complete true})
    (println (str "Completed: " (:title task) " [" (short-id (:id task)) "]"))))

(defn cmd-delete [args]
  (let [task (pick-task args)]
    (api :delete (str "/tasks/" (:id task)))
    (println (str "Deleted: " (:title task)))))

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
  (println "  gs add <title> [--due YYYY-MM-DD] [--list <name>] [--notes <text>] [--label <name>[,<name>...]]")
  (println "  gs done <query> | --id <id prefix>")
  (println "  gs delete <query> | --id <id prefix>")
  (println)
  (println "Environment:")
  (println "  GODSPEED_API_KEY    Required. Your Godspeed API key.")
  (println "  GODSPEED_CA_BUNDLE  Optional. PEM file of CA certs to trust (corporate proxy)."))

;; --- Dispatch ---
(when-not (g/api-key)
  (die "Error: GODSPEED_API_KEY environment variable not set"))

(let [[cmd & args] *command-line-args*]
  (try
    (case cmd
      "list"   (cmd-list args)
      "today"  (cmd-today args)
      "lists"  (cmd-lists args)
      "add"    (cmd-add args)
      "done"   (cmd-done args)
      "delete" (cmd-delete args)
      (cmd-help))
    (catch java.util.concurrent.ExecutionException e
      (die "Error:" (ex-message (or (ex-cause e) e))))
    (catch clojure.lang.ExceptionInfo e
      (die "Error:" (ex-message e)))
    (catch java.io.IOException e
      (die "Error: request failed:" (ex-message e)))))
