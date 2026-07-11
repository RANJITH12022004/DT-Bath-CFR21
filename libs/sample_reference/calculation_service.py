#!/usr/bin/env python3
"""
calculation_service.py - Business logic and calculation service
Handles recipe validation, unit conversions, statistics, tolerance checking, and parameter calculations.
"""

import math
from typing import Dict, List, Any, Optional, Tuple


def init():
    """Initialize calculation service"""
    pass


# =================== UNIT CONVERSIONS ==========================

# Conversion factors to Newton (N)
UNIT_CONVERSIONS = {
    "Newton (N)": 1.0,
    "KGF": 9.80665,  # Kilogram-force to Newton
    "Strong Cobb": 1 / 0.1428,  # Strong Cobb to Newton (1 N = 0.1428 SC, so 1 SC = 1/0.1428 N)
    "Pound (lb)": 4.44822,  # Pound-force to Newton
    "Kilogram (kg)": 9.80665,  # Same as KGF
}


def convert_unit(value: float, from_unit: str, to_unit: str, conversion_factor: Optional[float] = None) -> float:
    """
    Convert value from one unit to another.
    
    Args:
        value: Value to convert
        from_unit: Source unit name
        to_unit: Target unit name
        conversion_factor: Optional custom conversion factor (for user-defined units)
    
    Returns:
        Converted value
    """
    if from_unit == to_unit:
        return value
    
    # Convert to Newton first
    if from_unit == "User Defined" and conversion_factor is not None:
        # User-defined unit: conversion_factor is the factor to convert to Newton
        value_in_newton = value * conversion_factor
    elif from_unit in UNIT_CONVERSIONS:
        value_in_newton = value * UNIT_CONVERSIONS[from_unit]
    else:
        # Unknown unit, assume it's already in Newton
        value_in_newton = value
    
    # Convert from Newton to target unit
    if to_unit == "User Defined" and conversion_factor is not None:
        # User-defined unit: divide by conversion factor
        return value_in_newton / conversion_factor
    elif to_unit in UNIT_CONVERSIONS:
        return value_in_newton / UNIT_CONVERSIONS[to_unit]
    else:
        # Unknown unit, return as-is
        return value_in_newton


def calculate_conversion_factor(custom_unit_name: str, factor_value: float) -> float:
    """
    Calculate and validate conversion factor for custom unit.
    factor_value is the value that equals 1 Newton in the custom unit.
    """
    if factor_value <= 0:
        raise ValueError("Conversion factor must be positive")
    return factor_value


# =================== STATISTICS ==========================

def calculate_statistics(data_points: List[float]) -> Dict[str, Any]:
    """
    Calculate statistics from data points.
    
    Returns:
        Dict with: mean, max, min, range, std_dev, count
    """
    if not data_points:
        return {
            "mean": 0.0,
            "max": 0.0,
            "min": 0.0,
            "range": 0.0,
            "std_dev": 0.0,
            "count": 0
        }
    
    # Filter out None and invalid values
    valid_points = [float(x) for x in data_points if x is not None and (isinstance(x, (int, float)))]
    
    if not valid_points:
        return {
            "mean": 0.0,
            "max": 0.0,
            "min": 0.0,
            "range": 0.0,
            "std_dev": 0.0,
            "count": 0
        }
    
    count = len(valid_points)
    mean = sum(valid_points) / count
    max_val = max(valid_points)
    min_val = min(valid_points)
    range_val = max_val - min_val
    
    # Standard deviation
    if count > 1:
        variance = sum((x - mean) ** 2 for x in valid_points) / (count - 1)
        std_dev = math.sqrt(variance)
    else:
        std_dev = 0.0
    
    return {
        "mean": round(mean, 2),
        "max": round(max_val, 2),
        "min": round(min_val, 2),
        "range": round(range_val, 2),
        "std_dev": round(std_dev, 2),
        "count": count
    }


# =================== TOLERANCE CHECKING ==========================

def check_tolerance(value: float, nominal: float, tolerance_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Check if value is within tolerance.
    
    Args:
        value: Actual value
        nominal: Nominal/target value
        tolerance_config: Dict with 'type' ('percentage' or 'absolute') and 'value' (tolerance amount)
    
    Returns:
        Dict with: within_tolerance (bool), deviation, deviation_percent
    """
    if nominal == 0:
        return {
            "within_tolerance": True,
            "deviation": 0.0,
            "deviation_percent": 0.0
        }
    
    deviation = abs(value - nominal)
    deviation_percent = (deviation / abs(nominal)) * 100.0 if nominal != 0 else 0.0
    
    tolerance_type = tolerance_config.get("type", "percentage")
    tolerance_value = float(tolerance_config.get("value", 0))
    
    if tolerance_type == "percentage":
        within_tolerance = deviation_percent <= tolerance_value
    else:  # absolute
        within_tolerance = deviation <= tolerance_value
    
    return {
        "within_tolerance": within_tolerance,
        "deviation": round(deviation, 2),
        "deviation_percent": round(deviation_percent, 2),
        "tolerance_type": tolerance_type,
        "tolerance_value": tolerance_value
    }


def _resolve_t1_t2_bands(
    nominal: float, tolerance_config: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Match script.js resolveT1T2Bands: absolute limits when upperT1 or upperT2 > nominal,
    else legacy deviations from nominal (with optional percentage plausibility).
    Returns dict with lower_t1_limit, upper_t1_limit, lower_outer, upper_outer, has_t2.
    """
    upper_t1 = float(tolerance_config.get("upperT1", 0) or 0)
    upper_t2 = float(tolerance_config.get("upperT2", 0) or 0)
    lower_t1 = float(tolerance_config.get("lowerT1", 0) or 0)
    lower_t2 = float(tolerance_config.get("lowerT2", 0) or 0)
    plausibility = (tolerance_config.get("plausibility", "absolute") or "absolute").lower()

    raw_l2 = lower_t2
    raw_u2 = upper_t2
    u1, u2, l1, l2 = upper_t1, upper_t2, lower_t1, lower_t2
    absolute_spec = (u1 > nominal) or (u2 > nominal)

    if not absolute_spec and plausibility == "percentage" and nominal != 0:
        factor = abs(nominal) / 100.0
        u1 *= factor
        u2 *= factor
        l1 *= factor
        l2 *= factor

    if not absolute_spec:
        u1, u2, l1, l2 = abs(u1), abs(u2), abs(l1), abs(l2)

    has_t2 = (raw_u2 != 0) or (raw_l2 != 0)

    if absolute_spec:
        lower_t1_limit = l1
        upper_t1_limit = u1
        lower_outer = l2 if raw_l2 != 0 else lower_t1_limit
        upper_outer = u2 if raw_u2 != 0 else upper_t1_limit
    else:
        lower_t1_limit = nominal - l1
        upper_t1_limit = nominal + u1
        lower_outer = nominal - (l2 if raw_l2 != 0 else l1)
        upper_outer = nominal + (u2 if raw_u2 != 0 else u1)

    return {
        "lower_t1_limit": lower_t1_limit,
        "upper_t1_limit": upper_t1_limit,
        "lower_outer": lower_outer,
        "upper_outer": upper_outer,
        "has_t2": has_t2,
    }


def check_tolerance_t1_t2(value: float, nominal: float, tolerance_config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Three-tier tolerance check using T1/T2 bands.
    
    Args:
        value: Actual measured value
        nominal: Nominal/target value
        tolerance_config: Dict with upperT1, upperT2, lowerT1, lowerT2 (absolute or percentage per plausibility)
    
    Returns:
        Dict with: status ("PASS" | "T2_DEVIATION" | "FAIL"), deviation, message
    """
    upper_t1 = float(tolerance_config.get("upperT1", 0) or 0)
    upper_t2 = float(tolerance_config.get("upperT2", 0) or 0)
    lower_t1 = float(tolerance_config.get("lowerT1", 0) or 0)
    lower_t2 = float(tolerance_config.get("lowerT2", 0) or 0)
    plausibility = (tolerance_config.get("plausibility", "absolute") or "absolute").lower()

    # If no T1/T2 values, fall back to single-tolerance behavior
    if upper_t1 == 0 and upper_t2 == 0 and lower_t1 == 0 and lower_t2 == 0:
        tol = tolerance_config.get("value", 0)
        tol_type = tolerance_config.get("type", "absolute")
        if plausibility == "percentage":
            dev_pct = abs(value - nominal) / abs(nominal) * 100 if nominal != 0 else 0
            within = dev_pct <= (tol or 10)
        else:
            within = abs(value - nominal) <= (tol or 0)
        status = "PASS" if within else "FAIL"
        deviation = abs(value - nominal)
        return {
            "status": status,
            "deviation": round(deviation, 2),
            "message": "Within tolerance" if status == "PASS" else "Out of tolerance"
        }

    bands = _resolve_t1_t2_bands(nominal, tolerance_config)
    lower_t1_limit = bands["lower_t1_limit"]
    upper_t1_limit = bands["upper_t1_limit"]
    lower_outer = bands["lower_outer"]
    upper_outer = bands["upper_outer"]
    has_t2 = bands["has_t2"]

    deviation = round(abs(value - nominal), 2)

    if not has_t2:
        if lower_t1_limit <= value <= upper_t1_limit:
            return {"status": "PASS", "deviation": deviation, "message": "Within T1 tolerance"}
        return {"status": "FAIL", "deviation": deviation, "message": "Out of tolerance (beyond T1)"}

    if lower_t1_limit <= value <= upper_t1_limit:
        return {"status": "PASS", "deviation": deviation, "message": "Within T1 tolerance"}

    if (lower_outer <= value < lower_t1_limit) or (upper_t1_limit < value <= upper_outer):
        return {"status": "T2_DEVIATION", "deviation": deviation, "message": "T2 deviation - within T2 band"}

    return {"status": "FAIL", "deviation": deviation, "message": "Out of tolerance (beyond T2)"}


# =================== RECIPE VALIDATION ==========================

def validate_recipe(recipe_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Validate recipe data.
    
    Returns:
        Dict with: valid (bool), error (str if invalid)
    """
    errors = []
    
    # Required fields
    if not recipe_data.get("productName", "").strip():
        errors.append("Product name is required")
    
    # Batch number is optional when creating; entered when loading recipe
    
    # Sample size validation
    sample_size = recipe_data.get("sampleSize")
    try:
        sample_size = int(sample_size)
        if sample_size < 1 or sample_size > 100:
            errors.append("Sample size must be between 1 and 100")
    except (ValueError, TypeError):
        errors.append("Invalid sample size")
    
    # Unit validation
    unit = recipe_data.get("unit", "")
    if unit == "User Defined":
        conversion_factor = recipe_data.get("conversionFactor")
        if conversion_factor is None or conversion_factor <= 0:
            errors.append("Conversion factor required for user-defined unit")
    
    # Parameters validation - accept dict (frontend) or list (legacy) format
    parameters = recipe_data.get("parameters", [])
    if isinstance(parameters, dict):
        if len(parameters) == 0:
            errors.append("At least one parameter is required")
        else:
            for param_name, value in parameters.items():
                if param_name and str(value).strip():
                    try:
                        nominal = float(str(value).strip())
                        if nominal < 0:
                            errors.append(f"Parameter {param_name} value must be non-negative")
                    except (ValueError, TypeError):
                        errors.append(f"Invalid value for parameter {param_name}")
    elif isinstance(parameters, list):
        if len(parameters) == 0:
            errors.append("At least one parameter is required")
        else:
            for param in parameters:
                if not isinstance(param, dict):
                    errors.append("Invalid parameter format")
                    continue
                if not param.get("name", "").strip():
                    errors.append("Parameter name is required")
                nominal = param.get("nominal")
                try:
                    nominal = float(nominal)
                    if nominal < 0:
                        errors.append("Parameter nominal value must be non-negative")
                except (ValueError, TypeError):
                    errors.append("Invalid parameter nominal value")
    else:
        errors.append("At least one parameter is required")

    # Shape validation
    shape = recipe_data.get("shape", "")
    valid_shapes = ["round", "oval", "oblong", "capsule", "other"]
    if shape and shape not in valid_shapes:
        errors.append(f"Invalid shape. Must be one of: {', '.join(valid_shapes)}")
    
    if errors:
        return {
            "valid": False,
            "error": "; ".join(errors)
        }
    
    return {"valid": True}


def process_recipe_form_data(form_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process and normalize recipe form data.
    Calculates parameter samples and validates structure.
    """
    recipe = dict(form_data)
    
    # Ensure required fields
    if "id" not in recipe:
        recipe["id"] = None  # Will be generated by data_service
    
    # Normalize sample size
    try:
        sample_size = int(recipe.get("sampleSize", 10))
        recipe["sampleSize"] = max(1, min(100, sample_size))
    except (ValueError, TypeError):
        recipe["sampleSize"] = 10
    
    # Process parameters and calculate parameter samples
    parameters = recipe.get("parameters", [])
    if isinstance(parameters, list) and len(parameters) > 0:
        total_samples = recipe["sampleSize"]
        parameter_samples = calculate_parameter_samples(recipe, total_samples)
        recipe["parameterSamples"] = parameter_samples
    
    # Ensure timestamps
    if "createdAt" not in recipe:
        from datetime import datetime
        recipe["createdAt"] = datetime.utcnow().isoformat() + "Z"
    
    if "lastUsed" not in recipe:
        recipe["lastUsed"] = recipe["createdAt"]
    
    return recipe


def calculate_parameter_samples(recipe: Dict[str, Any], total_samples: int) -> Dict[str, int]:
    """
    Calculate how many samples to test for each parameter.
    
    Returns:
        Dict mapping parameter names to sample counts
    """
    parameters = recipe.get("parameters", [])
    if not parameters:
        return {}
    
    # Simple distribution: divide samples evenly among parameters
    # If total_samples is not divisible, distribute remainder
    num_params = len(parameters)
    if num_params == 0:
        return {}
    
    base_samples = total_samples // num_params
    remainder = total_samples % num_params
    
    parameter_samples = {}
    for i, param in enumerate(parameters):
        param_name = param.get("name", f"param_{i}")
        # Give remainder to first parameters
        samples = base_samples + (1 if i < remainder else 0)
        parameter_samples[param_name] = samples
    
    return parameter_samples


# =================== NUMERIC VALIDATION ==========================

def validate_numeric_input(value: Any, min_val: Optional[float] = None, max_val: Optional[float] = None) -> Tuple[bool, Optional[str]]:
    """
    Validate numeric input.
    
    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        num_value = float(value)
        
        if min_val is not None and num_value < min_val:
            return False, f"Value must be at least {min_val}"
        
        if max_val is not None and num_value > max_val:
            return False, f"Value must be at most {max_val}"
        
        return True, None
    except (ValueError, TypeError):
        return False, "Invalid numeric value"


# =================== TEST RESULT CALCULATIONS ==========================

def calculate_test_results(test_data: Dict[str, Any], recipe: Dict[str, Any]) -> Dict[str, Any]:
    """
    Calculate test results from raw test data and recipe.
    
    Args:
        test_data: Raw test data with measurements
        recipe: Recipe with parameters and tolerances
    
    Returns:
        Dict with calculated results, statistics, and pass/fail status
    """
    results = {
        "test_data": test_data,
        "recipe_id": recipe.get("id"),
        "recipe_name": recipe.get("name") or recipe.get("productName"),
        "parameters": {},
        "overall_status": "PASS",
        "statistics": {}
    }
    
    parameters = recipe.get("parameters", [])
    parameter_tolerances = recipe.get("parameterTolerances", {})
    
    for param in parameters:
        param_name = param.get("name", "")
        if not param_name:
            continue
        
        # Get measurements for this parameter
        measurements = test_data.get("measurements", {}).get(param_name, [])
        if not measurements:
            continue
        
        # Calculate statistics
        stats = calculate_statistics(measurements)
        
        # Check tolerance
        nominal = float(param.get("nominal", 0))
        tolerance_config = parameter_tolerances.get(param_name, {})
        if not tolerance_config:
            # Default tolerance: 10% if not specified
            tolerance_config = {"type": "percentage", "value": 10.0}
        
        # Check each measurement - use T1/T2 if available, else legacy tolerance
        passed = []
        failed = []
        t2_deviations = []
        has_t1_t2 = any(
            tolerance_config.get(k) is not None
            for k in ("upperT1", "upperT2", "lowerT1", "lowerT2")
        )
        for measurement in measurements:
            m = float(measurement)
            if has_t1_t2:
                tc = dict(tolerance_config)
                tc.setdefault("nominal", nominal)
                result = check_tolerance_t1_t2(m, nominal, tc)
                if result["status"] == "PASS":
                    passed.append(measurement)
                elif result["status"] == "T2_DEVIATION":
                    t2_deviations.append(measurement)
                else:
                    failed.append(measurement)
            else:
                tolerance_check = check_tolerance(m, nominal, tolerance_config)
                if tolerance_check["within_tolerance"]:
                    passed.append(measurement)
                else:
                    failed.append(measurement)
        
        # Overall parameter status: FAIL if any beyond T2, else T2_DEVIATION if any in T2, else PASS
        if len(failed) > 0:
            param_status = "FAIL"
        elif len(t2_deviations) > 0:
            param_status = "T2_DEVIATION"
        else:
            param_status = "PASS"
        if param_status == "FAIL":
            results["overall_status"] = "FAIL"
        elif param_status == "T2_DEVIATION" and results["overall_status"] == "PASS":
            results["overall_status"] = "T2_DEVIATION"
        
        results["parameters"][param_name] = {
            "nominal": nominal,
            "measurements": measurements,
            "statistics": stats,
            "tolerance_config": tolerance_config,
            "passed": len(passed),
            "failed": len(failed),
            "t2_deviations": len(t2_deviations) if has_t1_t2 else 0,
            "status": param_status
        }
    
    # Overall statistics
    all_measurements = []
    for param_results in results["parameters"].values():
        all_measurements.extend(param_results["measurements"])
    
    if all_measurements:
        results["statistics"] = calculate_statistics(all_measurements)
    
    return results
