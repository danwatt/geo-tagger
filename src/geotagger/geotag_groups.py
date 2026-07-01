from geotagger import index
import time

def get_next_geotag_group(start_year: int, after_ts: int = None, group_window_days: int = 1, context_window_days: int = 1):
    """Find the next group of non-geotagged photos to process."""
    date_from = f'{start_year}-01-01'
    if after_ts:
        # to get the next group, we need to start searching after the last timestamp
        date_from = time.strftime('%Y-%m-%d', time.localtime(after_ts + 1))

    ungeocoded = index.get_photos(geotagged='no', date_from=date_from)

    if not ungeocoded:
        return None

    # Find the first group of photos within the time window
    group_to_tag = []
    # if we are paginating, we need to find the first photo that is after the provided timestamp
    start_index = 0
    if after_ts:
        for i, photo in enumerate(ungeocoded):
            if photo['photo_datetime'] > after_ts:
                start_index = i
                break

    for i in range(start_index, len(ungeocoded)):
        photo = ungeocoded[i]
        if not photo['photo_datetime']:
            continue

        if not group_to_tag:
            group_to_tag.append(photo)
        else:
            time_diff = photo['photo_datetime'] - group_to_tag[-1]['photo_datetime']
            if time_diff <= group_window_days * 86400:
                group_to_tag.append(photo)
            else:
                # This group is finished, let's process it
                break
        # If it's the last photo, the group is also finished
        if i == len(ungeocoded) - 1:
            break

    if not group_to_tag:
        return None

    start_ts = group_to_tag[0]['photo_datetime']
    end_ts = group_to_tag[-1]['photo_datetime']

    # Get before and after photos
    before_photos = index.get_photos_by_time_range(
        min_time=start_ts - context_window_days * 86400,
        max_time=start_ts,
        has_geotag=True
    )

    after_photos = index.get_photos_by_time_range(
        min_time=end_ts,
        max_time=end_ts + context_window_days * 86400,
        has_geotag=True
    )

    return {
        'before': before_photos,
        'to_tag': group_to_tag,
        'after': after_photos
    }
