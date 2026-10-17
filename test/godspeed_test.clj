(ns godspeed-test
  (:require [clojure.test :refer [deftest is testing]]
            [godspeed :as g]))

(def labels [{:id "1" :name "wip"} {:id "2" :name "Errand"}])

(deftest find-by-name
  (is (= "2" (g/find-by-name "Errand" labels)))
  (is (= "2" (g/find-by-name "errand" labels)))
  (is (nil? (g/find-by-name "nope" labels))))

(deftest resolve-label-ids
  (is (= ["1" "2"] (g/resolve-label-ids "wip, errand" labels)))
  (is (thrown-with-msg? clojure.lang.ExceptionInfo #"'nope' not found"
                        (g/resolve-label-ids "wip,nope" labels))))

(deftest today-task
  (testing "wip label, overdue, due today, future due, started"
    (is (g/today-task? {:label_ids ["1"]} "1" "2026-10-17"))
    (is (g/today-task? {:timeless_due_at "2026-10-01"} nil "2026-10-17"))
    (is (g/today-task? {:timeless_due_at "2026-10-17"} nil "2026-10-17"))
    (is (not (g/today-task? {:timeless_due_at "2026-10-18"} nil "2026-10-17")))
    (is (g/today-task? {:timeless_starts_at "2026-10-17"} nil "2026-10-17"))
    (is (not (g/today-task? {} nil "2026-10-17")))))

(deftest fuzzy-match
  (is (= 1 (count (g/fuzzy-match "milk" [{:title "Buy MILK"} {:title "Bread"}]))))
  (is (= 0 (count (g/fuzzy-match "x" [{:title nil}])))))

(deftest valid-date
  (is (g/valid-date? "2026-10-17"))
  (is (not (g/valid-date? "2026-13-45")))
  (is (not (g/valid-date? "tomorrow")))
  (is (not (g/valid-date? nil))))

(deftest find-by-name-ignores-emoji
  (let [items [{:id "a" :name "🏠 Household"} {:id "b" :name "💰 Finances"}
               {:id "c" :name "🚀 Personal"} {:id "d" :name "Personal"}]]
    (is (= "a" (g/find-by-name "household" items)))
    (is (= "a" (g/find-by-name "Household" items)))
    (is (= "d" (g/find-by-name "Personal" items)) "exact match beats decoration-stripped")
    (let [dup [{:id "x" :name "🚀 Personal"} {:id "y" :name "📁 Personal"}]]
      (is (nil? (g/find-by-name "personal" (map #(assoc % :name (str "a" (:name %))) dup)))
          "ambiguous after stripping -> nil")
      (is (nil? (g/find-by-name "Personal" dup))))))

(deftest lists-with-folders
  (let [ls [{:name "Inbox" :list_type "inbox" :order_index -3 :indent_level 0}
            {:name "S" :list_type "smart" :order_index 1 :indent_level 1}
            {:name "Work" :list_type "folder" :order_index 10 :indent_level 0}
            {:name "Sub" :list_type "folder" :order_index 11 :indent_level 1}
            {:name "A" :list_type "list" :order_index 12 :indent_level 2}
            {:name "B" :list_type "list" :order_index 13 :indent_level 1}
            {:name "Someday" :list_type "folder" :order_index 20 :indent_level 0}
            {:name "C" :list_type "list" :order_index 21 :indent_level 1}]
        by (into {} (map (juxt :name :folder)) (g/lists-with-folders ls))]
    (is (nil? (by "Inbox")))
    (is (not (contains? by "S")))
    (is (= "Sub" (by "A")))
    (is (= "Work" (by "B")))
    (is (= "Someday" (by "C")))
    (is (nil? (by "Someday")))))

(deftest resolve-list-id-only-taskable
  (let [ls [{:id "f" :name "Projects" :list_type "folder"} {:id "s" :name "Projects" :list_type "smart"}
            {:id "l" :name "📦 Projects" :list_type "list"}]]
    (is (= "l" (g/resolve-list-id "Projects" ls)))))
