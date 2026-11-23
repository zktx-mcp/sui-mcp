// Executed inside the unmodified v9 protocol test environment.
#[test_only]
module deepbook::review_fee_lot_tests;

use deepbook::balance_manager_tests::{USDC, create_acct_and_share_with_funds};
use deepbook::{constants, pool::Pool, pool_tests, registry};
use std::unit_test::destroy;
use sui::{clock::Clock, coin, sui::SUI, test_scenario::{Self, Scenario, return_shared}};
use token::deep::DEEP;

fun buy(pool_id: ID, budget: u64, expected_base: u64, expected_fee: u64, sc: &mut Scenario) {
    sc.next_tx(@0xb);
    let mut pool = sc.take_shared_by_id<Pool<SUI, USDC>>(pool_id);
    let clock = sc.take_shared<Clock>();
    let (base, quote, fee) = pool.swap_exact_quote_for_base(
        coin::mint_for_testing(2000, sc.ctx()), coin::mint_for_testing(budget, sc.ctx()),
        1000, &clock, sc.ctx());
    assert!(base.value() == expected_base && quote.value() == 0);
    assert!(budget - fee.value() == expected_fee);
    base.burn_for_testing();
    quote.burn_for_testing();
    fee.burn_for_testing();
    return_shared(clock);
    return_shared(pool);
}

#[test]
fun one_extra_base_lot_preserves_fee_and_refund() {
    let mut sc = test_scenario::begin(@0x1);
    let reg = pool_tests::setup_test(@0x1, &mut sc);
    let maker = @0xaaaa;
    let bm = create_acct_and_share_with_funds(maker, 1000000000000000, &mut sc);
    let pool_id = pool_tests::setup_pool_with_default_fees_and_reference_pool<SUI, USDC, SUI, DEEP>(
        maker, reg, bm, &mut sc);
    sc.next_tx(@0x1);
    let mut pool = sc.take_shared_by_id<Pool<SUI, USDC>>(pool_id);
    let clock = sc.take_shared<Clock>();
    let admin = registry::get_admin_cap_for_testing(sc.ctx());
    pool.adjust_min_lot_size_admin(1000, 1000, &admin, &clock);
    assert!(pool.get_order_deep_price().asset_is_base());
    destroy(admin);
    return_shared(pool);
    return_shared(clock);
    let scale = constants::float_scaling();
    pool_tests::place_limit_order<SUI, USDC>(maker, pool_id, bm, 1, constants::no_restriction(),
        constants::self_matching_allowed(), 2 * scale, 10000, false, true, constants::max_u64(), &mut sc);
    sc.next_tx(@0xb);
    let pool = sc.take_shared_by_id<Pool<SUI, USDC>>(pool_id);
    let clock = sc.take_shared<Clock>();
    let (base, _, quoted) = pool.get_base_quantity_out(2000, &clock);
    let (_, _, next_fee) = pool.get_base_quantity_out(4000, &clock);
    assert!(base == 1000 && quoted > 0 && next_fee > (quoted * 110 + 99) / 100);
    return_shared(pool);
    return_shared(clock);
    buy(pool_id, next_fee, base, quoted, &mut sc);
    pool_tests::place_limit_order<SUI, USDC>(maker, pool_id, bm, 2, constants::no_restriction(),
        constants::self_matching_allowed(), scale, 10000, false, true, constants::max_u64(), &mut sc);
    buy(pool_id, next_fee, base + 1000, next_fee, &mut sc);
    sc.end();
}
