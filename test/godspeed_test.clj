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
