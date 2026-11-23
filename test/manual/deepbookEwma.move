// Run in the tests directory of the pinned v9 DeepBook Move package.
#[test_only]
module deepbook::review_fee_tests;

use deepbook::ewma;

#[test]
fun quote_rate_and_triggered_order_rate() {
    let ctx = tx_context::create(@0x1, tx_context::dummy_tx_hash_with_hint(1), 0, 0, 0,
        1000, 1000, 1000000000, option::none());
    let mut state = ewma::init_ewma_state(&ctx);
    state.set_mean_for_testing(999_000_000_000);
    state.set_variance_for_testing(1_000_000_000);
    state.set_z_score_threshold(0);
    state.set_additional_taker_fee(1_000_000);
    assert!(state.apply_taker_penalty(200_000, &ctx) == 200_000);
    state.enable();
    assert!(state.apply_taker_penalty(200_000, &ctx) == 1_200_000);
    assert!(state.apply_taker_penalty(0, &ctx) == 1_000_000);
    state.set_mean_for_testing(1_001_000_000_000);
    assert!(state.apply_taker_penalty(200_000, &ctx) == 200_000);
}
