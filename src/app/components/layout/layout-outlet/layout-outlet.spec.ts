import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LayoutOutlet } from './layout-outlet';

describe('LayoutOutlet', (): void => {
  let component: LayoutOutlet;
  let fixture: ComponentFixture<LayoutOutlet>;

  beforeEach(async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [LayoutOutlet]
    })
    .compileComponents();

    fixture = TestBed.createComponent(LayoutOutlet);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });
});
