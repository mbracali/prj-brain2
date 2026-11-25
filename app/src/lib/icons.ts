// A curated set of Google Material Symbols for pickers and autocomplete.
// Any valid Material Symbols name renders (the font uses ligatures); this list
// only drives suggestions. Full catalogue: https://fonts.google.com/icons
export const MATERIAL_ICONS = `
home star favorite bookmark bookmarks label sell flag push_pin lightbulb psychology neurology
description article note sticky_note_2 edit_note draft folder folder_open topic inventory_2 archive
book menu_book auto_stories library_books school science biotech calculate functions code terminal
data_object integration_instructions bug_report build construction settings tune extension
work business_center apartment store account_balance payments savings attach_money receipt_long
shopping_cart sell credit_card wallet person group groups family_restroom face badge contacts
mail chat forum sms call videocam campaign notifications event calendar_month calendar_today
schedule alarm timer hourglass_empty history update today date_range event_note
check check_circle task_alt done_all radio_button_unchecked checklist list format_list_bulleted
format_list_numbered view_kanban dashboard grid_view table_chart insights analytics monitoring
trending_up trending_down bar_chart pie_chart show_chart query_stats leaderboard
public language travel_explore map place location_on explore flight hotel restaurant local_cafe
directions_car directions_bike directions_walk train sailing beach_access hiking fitness_center
sports_soccer sports_esports music_note headphones movie photo_camera image palette brush
draw design_services architecture category interests extension_off rocket_launch bolt
local_fire_department whatshot ac_unit water_drop eco park forest spa pets cruelty_free
cloud cloud_upload cloud_download sync backup storage database dns memory devices smartphone
laptop desktop_windows keyboard mouse router wifi bluetooth battery_full power
lock lock_open key shield security verified_user admin_panel_settings policy vpn_key
visibility visibility_off search zoom_in zoom_out filter_alt sort tune swap_horiz swap_vert
add remove close delete delete_forever restore undo redo refresh autorenew cached
arrow_forward arrow_back arrow_upward arrow_downward chevron_right chevron_left expand_more
expand_less open_in_new launch link link_off share send reply forward content_copy content_paste
upload download attach_file print save save_as file_open file_present
info help help_center warning error report priority_high new_releases campaign
thumb_up thumb_down sentiment_satisfied sentiment_dissatisfied mood favorite_border
emoji_objects emoji_events military_tech workspace_premium diamond celebration cake redeem
smart_toy robot_2 hub account_tree schema lan device_hub graphic_eq waves
medical_services health_and_safety medication vaccines healing monitor_heart
light_mode dark_mode contrast brightness_6 wb_sunny nights_stay
`
  .split(/\s+/)
  .filter(Boolean)
  .filter((v, i, a) => a.indexOf(v) === i);
